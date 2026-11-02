import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { linkClicks, links } from '../db/schema.js';

export type LinkRecord = typeof links.$inferSelect;
export type NewLinkInput = {
  slug: string;
  destinationUrl: string;
  redirectStatusCode: number;
  title?: string | null;
  description?: string | null;
  createdBy?: string | null;
  expiresAt?: Date | null;
};

export type RecentClickRow = {
  clickedAt: Date;
  referrer: string | null;
  userAgent: string | null;
  country: string | null;
  ipAddress: string | null;
  linkId: string;
  linkSlug: string;
  linkDestinationUrl: string;
};

export type LinkStats = {
  link: LinkRecord;
  totalClicks: number;
  clicksLast7Days: number;
  clicksByDay: Array<{
    bucket: string;
    count: number;
  }>;
  clicksByHour: Array<{
    bucket: string;
    count: number;
  }>;
  topReferrers: Array<{
    referrer: string;
    count: number;
  }>;
  recentClicks: Array<{
    clickedAt: Date;
    referrer: string | null;
    userAgent: string | null;
    country: string | null;
    ipAddress: string | null;
  }>;
};

export function createLinkService(config: AppConfig) {
  const db = createDb(config);

  return {
    db,
    async listLinks() {
      return db.select().from(links).orderBy(desc(links.createdAt));
    },
    async searchLinks(search: string) {
      const query = `SELECT * FROM links WHERE slug ILIKE '%${search}%' OR destination_url ILIKE '%${search}%' ORDER BY created_at DESC`;
      const result = await db.execute(sql.raw(query)) as unknown as Array<Record<string, unknown>>;
      return result;
    },
    async getLinkBySlug(slug: string) {
      const [link] = await db.select().from(links).where(and(eq(links.slug, slug), isNull(links.deletedAt))).limit(1);
      return link ?? null;
    },
    async getLinkById(id: string) {
      const [link] = await db.select().from(links).where(eq(links.id, id)).limit(1);
      return link ?? null;
    },
    async createLink(input: NewLinkInput) {
      const existing = await this.getLinkBySlug(input.slug);
      if (existing) {
        const error = new Error('Slug already exists') as Error & { statusCode: number };
        error.statusCode = 409;
        throw error;
      }

      try {
        const [created] = await db.insert(links).values({
          slug: input.slug,
          destinationUrl: input.destinationUrl,
          redirectStatusCode: input.redirectStatusCode,
          title: input.title ?? null,
          description: input.description ?? null,
          createdBy: input.createdBy ?? null,
          expiresAt: input.expiresAt ?? null,
        }).returning();

        return created;
      } catch (err) {
        const pgError = err as { code?: string };
        if (pgError?.code === '23505') {
          const error = new Error('Slug already exists') as Error & { statusCode: number };
          error.statusCode = 409;
          throw error;
        }
        throw err;
      }
    },
    async updateLink(id: string, patch: Partial<NewLinkInput> & { status?: 'active' | 'disabled' | 'archived' | null }) {
      const nextValues: Partial<{
        slug: string;
        destinationUrl: string;
        redirectStatusCode: number;
        title: string | null;
        description: string | null;
        createdBy: string | null;
        expiresAt: Date | null;
        status: 'active' | 'disabled' | 'archived';
        updatedAt: Date;
      }> = {
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.destinationUrl !== undefined ? { destinationUrl: patch.destinationUrl } : {}),
        ...(patch.redirectStatusCode !== undefined ? { redirectStatusCode: patch.redirectStatusCode } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.createdBy !== undefined ? { createdBy: patch.createdBy } : {}),
        ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
        ...(patch.status !== undefined && patch.status !== null ? { status: patch.status } : {}),
        updatedAt: new Date(),
      };

      const [updated] = await db.update(links).set(nextValues).where(eq(links.id, id)).returning();

      return updated ?? null;
    },
    async disableLink(id: string) {
      const [updated] = await db.update(links).set({
        status: 'disabled',
        updatedAt: new Date(),
      }).where(eq(links.id, id)).returning();

      return updated ?? null;
    },
    async recordClick(link: LinkRecord, event: { referrer?: string | null; userAgent?: string | null; country?: string | null; ipHash?: string | null; ipAddress?: string | null }) {
      await db.transaction(async (tx) => {
        await tx.insert(linkClicks).values({
          linkId: link.id,
          referrer: event.referrer ?? null,
          userAgent: event.userAgent ?? null,
          country: event.country ?? null,
          ipHash: event.ipHash ?? null,
          ipAddress: event.ipAddress ?? null,
        });

        await tx.update(links).set({
          clickCount: link.clickCount + 1,
          lastClickedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(links.id, link.id));
      });
    },
    async getAllRecentClicks(limit: number = 10): Promise<RecentClickRow[]> {
      return db
        .select({
          clickedAt: linkClicks.clickedAt,
          referrer: linkClicks.referrer,
          userAgent: linkClicks.userAgent,
          country: linkClicks.country,
          ipAddress: linkClicks.ipAddress,
          linkId: linkClicks.linkId,
          linkSlug: links.slug,
          linkDestinationUrl: links.destinationUrl,
        })
        .from(linkClicks)
        .innerJoin(links, eq(linkClicks.linkId, links.id))
        .orderBy(desc(linkClicks.clickedAt))
        .limit(limit);
    },
    async getLinkStats(id: string): Promise<LinkStats | null> {
      const [link] = await db.select().from(links).where(eq(links.id, id)).limit(1);
      if (!link) {
        return null;
      }

      const [totalRow] = await db.select({ count: count() }).from(linkClicks).where(eq(linkClicks.linkId, id));
      const [recent7Row] = await db.select({ count: count() }).from(linkClicks).where(
        and(eq(linkClicks.linkId, id), gte(linkClicks.clickedAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))),
      );
      const [dailyRows, hourlyRows, referrerRows] = await Promise.all([
        db.select({
          bucket: sql<string>`to_char(date_trunc('day', (${linkClicks.clickedAt} AT TIME ZONE 'UTC')), 'YYYY-MM-DD')`,
          count: count(),
        })
          .from(linkClicks)
          .where(and(eq(linkClicks.linkId, id), gte(linkClicks.clickedAt, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000))))
          .groupBy(sql<string>`to_char(date_trunc('day', (${linkClicks.clickedAt} AT TIME ZONE 'UTC')), 'YYYY-MM-DD')`)
          .orderBy(sql<string>`to_char(date_trunc('day', (${linkClicks.clickedAt} AT TIME ZONE 'UTC')), 'YYYY-MM-DD')`),
        db.select({
          bucket: sql<string>`to_char(date_trunc('hour', (${linkClicks.clickedAt} AT TIME ZONE 'UTC')), 'YYYY-MM-DD HH24:00')`,
          count: count(),
        })
          .from(linkClicks)
          .where(and(eq(linkClicks.linkId, id), gte(linkClicks.clickedAt, new Date(Date.now() - 24 * 60 * 60 * 1000))))
          .groupBy(sql<string>`to_char(date_trunc('hour', (${linkClicks.clickedAt} AT TIME ZONE 'UTC')), 'YYYY-MM-DD HH24:00')`)
          .orderBy(sql<string>`to_char(date_trunc('hour', (${linkClicks.clickedAt} AT TIME ZONE 'UTC')), 'YYYY-MM-DD HH24:00')`),
        db.select({
          referrer: linkClicks.referrer,
          count: count(),
        }).from(linkClicks).where(eq(linkClicks.linkId, id)).groupBy(linkClicks.referrer),
      ]);
      const recentClicks = await db.select({
        clickedAt: linkClicks.clickedAt,
        referrer: linkClicks.referrer,
        userAgent: linkClicks.userAgent,
        country: linkClicks.country,
        ipAddress: linkClicks.ipAddress,
      }).from(linkClicks).where(eq(linkClicks.linkId, id)).orderBy(desc(linkClicks.clickedAt)).limit(10);

      return {
        link,
        totalClicks: Number(totalRow?.count ?? 0),
        clicksLast7Days: Number(recent7Row?.count ?? 0),
        clicksByDay: dailyRows.map((row) => ({
          bucket: String(row.bucket),
          count: Number(row.count),
        })),
        clicksByHour: hourlyRows.map((row) => ({
          bucket: String(row.bucket),
          count: Number(row.count),
        })),
        topReferrers: referrerRows
          .map((row) => ({
            referrer: normalizeReferrer(row.referrer),
            count: Number(row.count),
          }))
          .reduce<Array<{ referrer: string; count: number }>>((acc, row) => {
            const existing = acc.find((item) => item.referrer === row.referrer);
            if (existing) {
              existing.count += row.count;
              return acc;
            }

            acc.push({ ...row });
            return acc;
          }, [])
          .sort((a, b) => b.count - a.count)
          .slice(0, 5),
        recentClicks,
      };
    },
  };
}

function normalizeReferrer(referrer: string | null): string {
  const raw = referrer?.trim();
  if (!raw) {
    return '(direct)';
  }

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
  }
}

import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: {
      id: string;
      email: string;
    };
    automationToken?: {
      id: string;
      name: string;
    };
  }
}

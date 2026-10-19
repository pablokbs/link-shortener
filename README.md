# Link Shortener

[Read in English](README.en.md)

Acortador de enlaces autohospedado con dominio propio, panel administrativo y analíticas de clics. Está construido con Node.js, Fastify, PostgreSQL y Docker.

![Panel administrativo de Link Shortener](docs/assets/admin-dashboard.png)

## Instalación rápida en un VPS de HostGator

> Esta guía requiere un **VPS con Ubuntu 22.04, 24.04 o 26.04 y una sesión SSH como `root`**. Todos los comandos siguientes asumen que ya ingresaste como `root`. No funciona en un plan de hosting compartido.

Podés contratar un VPS en HostGator usando [mi enlace](https://go.peladonerd.com/hostgator). Es un enlace de afiliado: obtenés un descuento especial —cuyo valor puede variar— y, además, ayudás a mantener el proyecto.

### 1. Crear el servidor y apuntar el dominio

1. Creá un VPS con Ubuntu y anotá su dirección IPv4 pública.
2. En el proveedor DNS de tu dominio, creá un registro `A` para el subdominio que quieras usar y apuntalo a la IPv4 pública del VPS. Si HostGator administra el DNS, seguí su guía oficial: [Cómo crear o cambiar un registro en la zona DNS](https://soporte.hostgator.mx/hc/es-419/articles/28440862844179-C%C3%B3mo-crear-o-cambiar-un-registro-A-CNAME-MX-TXT-y-otros-en-la-zona-DNS). Si usás los nameservers de otro proveedor —por ejemplo, Cloudflare—, creá el registro en el panel de ese proveedor.

   Ejemplo:

   ```text
   go.example.com -> 203.0.113.10
   ```

3. Esperá a que el DNS resuelva hacia el VPS.
4. Verificá que los puertos TCP `80` y `443` estén permitidos en el firewall de HostGator y del servidor.

### 2. Instalar Docker Engine y Docker Compose

Usá el [repositorio oficial de Docker para Ubuntu](https://docs.docker.com/engine/install/ubuntu/):

```bash
apt update
apt install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt update
apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

docker run --rm hello-world
docker compose version
```

No hace falta instalar Node.js, npm, PostgreSQL, Caddy ni Certbot en el host: todo corre dentro de contenedores.

### 3. Descargar y configurar Link Shortener

```bash
git clone https://github.com/pablokbs/link-shortener.git
cd link-shortener
cp .env.production.example .env.production
chmod 600 .env.production
```

Editá `.env.production` y reemplazá los valores de ejemplo:

```bash
nano .env.production
```

Generá valores seguros con:

```bash
openssl rand -hex 32
openssl rand -base64 48
```

- `SHORTENER_DOMAIN`: sólo el hostname, sin `https://` ni `/` final.
- `POSTGRES_PASSWORD`: usá el valor hexadecimal generado.
- `SESSION_SECRET`: usá el valor Base64; debe tener al menos 32 caracteres.

### 4. Levantar la aplicación con HTTPS

```bash
docker compose --env-file .env.production \
  -f compose.production.yml up --build -d

docker compose --env-file .env.production \
  -f compose.production.yml ps
```

El stack incluye:

- Link Shortener;
- PostgreSQL, accesible sólo desde la red interna de Docker;
- Caddy como reverse proxy;
- certificados TLS de Let's Encrypt, emitidos y renovados automáticamente.

Comprobá el servicio:

```bash
curl "https://$(grep '^SHORTENER_DOMAIN=' .env.production | cut -d= -f2)/healthz"
```

### 5. Crear el primer administrador

```bash
docker compose --env-file .env.production \
  -f compose.production.yml exec app \
  npm run create-admin -- \
  --email=admin@example.com
```

Después ingresá en:

```text
https://go.example.com/admin/login
```

El comando pide la contraseña de forma interactiva y oculta, sin guardarla en el
historial ni en los argumentos del proceso.

### Operación diaria

```bash
# Ver logs
docker compose --env-file .env.production -f compose.production.yml logs -f

# Actualizar a la última versión
git pull --ff-only
docker compose --env-file .env.production \
  -f compose.production.yml up --build -d

# Detener el stack sin borrar datos
docker compose --env-file .env.production \
  -f compose.production.yml down
```

Los datos persistentes viven en volúmenes de Docker. No uses `down -v` salvo que realmente quieras borrar la base y los certificados.

## Funcionalidades

- URLs cortas con dominio propio.
- Redirecciones configurables: 301, 302, 307 y 308.
- Panel administrativo con sesiones, contraseñas Argon2id y protección CSRF.
- Crear, editar, desactivar y archivar enlaces.
- Vencimiento, título, descripción y metadatos por enlace.
- Analíticas globales y por enlace: series temporales, países, referrers y clics recientes.
- API JSON para automatización.
- Tokens de automatización revocables con permisos separados de lectura, escritura y estadísticas; ver [acceso para agentes](docs/automation.md).
- Captura de IP respetuosa de la privacidad: sólo se guarda un hash.

## Arquitectura

- **Runtime:** Node.js 22 + TypeScript 5
- **Servidor:** Fastify 5
- **Base de datos:** PostgreSQL 16 + Drizzle ORM
- **Dashboard:** HTMX + Chart.js
- **Producción:** Docker Compose + Caddy + Let's Encrypt

## Desarrollo local

```bash
cp .env.example .env
docker compose up --build -d
docker compose exec app npm run create-admin -- \
  --email=admin@example.com \
  --password='una-contraseña-segura'
```

Abrí `http://localhost:3000/admin/login`.

Comandos útiles:

```bash
npm run dev
npm run check
npm test
npm run migrate
npm run seed       # sólo desarrollo; modifica datos de demo
npm run db:generate
```

## Variables de entorno

La aplicación valida la configuración al arrancar y falla inmediatamente si falta un valor requerido.

| Variable | Requerida | Predeterminado | Descripción |
| --- | --- | --- | --- |
| `SHORTENER_DOMAIN` | Sí | — | Hostname público usado para construir enlaces cortos. |
| `SHORTENER_SCHEME` | No | `https` | Esquema público: `http` o `https`. |
| `DATABASE_URL` | Sí | — | URL de conexión a PostgreSQL. En producción la arma Compose. |
| `SESSION_SECRET` | Sí | — | Secreto de al menos 32 caracteres para cookies y CSRF. |
| `SESSION_MAX_AGE_SECONDS` | No | `604800` | Duración de la sesión. |
| `SESSION_COOKIE_NAME` | No | `link_shortener_session` | Nombre de la cookie de sesión. |
| `CSRF_COOKIE_NAME` | No | `link_shortener_csrf` | Nombre de la cookie CSRF. |
| `REDIRECT_STATUS_CODE` | No | `302` | Código de redirección predeterminado. |
| `ADMIN_TOKEN` | No | — | Compatibilidad heredada para la API; no usar en instalaciones nuevas. |

## API principal

| Método | Ruta | Autenticación | Descripción |
| --- | --- | --- | --- |
| `GET` | `/healthz` | No | Estado del servicio. |
| `GET` | `/api/links` | No | Lista resumida de enlaces. |
| `POST` | `/api/links` | Sí | Crea un enlace. |
| `GET` | `/api/links/:id` | Sí | Obtiene un enlace. |
| `PATCH` | `/api/links/:id` | Sí | Actualiza un enlace. |
| `DELETE` | `/api/links/:id` | Sí | Desactiva un enlace. |
| `GET` | `/api/links/:id/stats` | Sí | Devuelve estadísticas. |
| `GET` | `/:slug` | No | Registra el clic y redirige. |

## Seguridad

- Nunca publiques `.env` ni `.env.production`.
- PostgreSQL no publica puertos en el Compose de producción.
- Sólo Caddy escucha en `80/443`.
- No ejecutes `npm run seed` contra producción.
- Consultá [SECURITY.md](SECURITY.md) para reportar vulnerabilidades.

## Reutilizar el workflow de deploy

El workflow incluido siempre ejecuta validaciones en los pull requests. Cuando hay un push a `main`, construye y publica la imagen como `ghcr.io/<owner>/<repositorio>`.

El deploy remoto está deshabilitado de forma predeterminada en los forks. Para habilitarlo en tu propio repositorio, configurá:

**Variables de Actions** (`Settings -> Secrets and variables -> Actions -> Variables`):

- `DEPLOY_ENABLED`: `true`.
- `DEPLOY_COMMAND`: comando que se ejecutará en el servidor después de publicar la imagen. Los valores de variables se pasan como texto plano; si necesitás `${{ github.sha }}`, escribí esa expresión directamente en tu copia del workflow. Ejemplo: `cd /opt/link-shortener && ./deploy.sh`.

**Secrets de Actions** (`Settings -> Secrets and variables -> Actions -> Secrets`):

- `DEPLOY_HOST`: hostname o dirección IP del servidor.
- `DEPLOY_USER`: usuario SSH.
- `DEPLOY_SSH_KEY`: clave SSH privada autorizada para ese usuario.

El comando remoto debe descargar la imagen o el código nuevo y reiniciar el stack. Guardá la clave privada únicamente como secret de GitHub Actions: nunca la subas al repositorio ni la guardes como variable.

## Documentación

- [Arquitectura](docs/architecture.md)
- [Roadmap](docs/roadmap.md)
- [Decisiones técnicas](docs/decisions/0001-stack.md)
- [Autenticación](docs/decisions/auth.md)
- [Automatización y agentes](docs/automation.md)
- [Contribuir](CONTRIBUTING.md)

## Licencia

[MIT](LICENSE) — Copyright © 2026 Pablo Fredrikson.

# IDE Nacional del Perú (IDEP) — Módulo de Carga y Registro

Módulo de gestión para una **Infraestructura de Datos Espaciales** institucional:
carga de archivos geográficos no interoperables, validación de calidad
**ISO 19157**, almacenamiento en **PostGIS**, publicación de servicios OGC en
**GeoServer**, metadatos **Perfil Básico CCIDEP v2.2 (ISO 19115/19139)** con
sincronización a un **GeoNetwork existente**, catálogo de objetos
**ISO 19110**, usuarios/roles por entidad, auditoría, versionamiento con
rollback, respaldo/restauración de servicios y monitoreo con alertas por
correo y panel.

## Índice

- [Arquitectura](#arquitectura)
- [Puesta en marcha](#puesta-en-marcha)
- [El asistente «Registrar»](#el-asistente-registrar)
- [Flujo de uso](#flujo-de-uso)
- [Estructura del repositorio](#estructura-del-repositorio)
- [API principal](#api-principal-apiv1)
- [Roles](#roles)
- [Variables de entorno](#variables-de-entorno)
- [Notas de seguridad para producción](#notas-de-seguridad-para-producción)
- [Solución de problemas](#solución-de-problemas)

## Arquitectura

Todo corre con **Docker Compose** sobre una sola VM (o sobre Docker Desktop en
un equipo de desarrollo):

| Contenedor | Imagen | Rol |
|---|---|---|
| `nginx` | nginx:1.27-alpine | Reverse proxy — expone la app y `/geoserver` en el puerto 80 |
| `ide-app` | build local (Node 20) | API REST `/api/v1`, panel `/admin`, catálogo `/catalogo`, jobs cron |
| `ide-postgis` | postgis/postgis:16-3.4 | Schema `ide` (catálogo del módulo) + schema `datos` (capas espaciales) |
| `ide-geoserver` | docker.osgeo.org/geoserver:2.25.2 | Servicios OGC: WMS / WFS / WCS |
| `ide-gdal` | ghcr.io/osgeo/gdal (worker) | `ogrinfo` / `ogr2ogr` invocado vía `docker exec` |

**GeoNetwork no se levanta aquí**: es la instancia institucional existente,
configurada por variables de entorno (`GEONETWORK_URL/USER/PASS`). Si no se
configura, el módulo sigue funcionando — los metadatos quedan disponibles
localmente (XML ISO 19139) y el push queda pendiente en `sync_queue`.

```
Cliente ─▶ nginx :80 ─┬─▶ ide-app :3000  ──▶ ide-postgis :5432
                       │        │
                       │        └──▶ docker exec ──▶ ide-gdal
                       └─▶ ide-geoserver :8080 ──▶ ide-postgis :5432 (datastore PostGIS)

ide-app ──▶ (externo) GeoNetwork institucional
ide-app ──▶ (externo) SMTP (alertas de monitoreo)
```

## Puesta en marcha

### Requisitos

- Docker + Docker Compose v2 (Docker Desktop en Windows/Mac, o Docker Engine en Linux)
- 4 GB de RAM libres como mínimo (GeoServer es el que más consume)

### Pasos

```bash
git clone https://github.com/rcluiseloy/idep.git
cd idep
cp .env.example .env        # editar JWT_SECRET, ADMIN_PASSWORD, POSTGRES_PASSWORD…
docker compose up -d --build
```

Las migraciones SQL y el usuario administrador semilla se aplican
automáticamente al arrancar `ide-app` (ver `server.js`).

- **Panel de administración**: http://localhost/admin
  (login con `ADMIN_EMAIL` / `ADMIN_PASSWORD`; si `ADMIN_PASSWORD` quedó vacío
  en `.env`, la contraseña generada aparece en `docker compose logs ide-app`)
- **Catálogo público**: http://localhost/catalogo (sin login)
- **Salud del stack**: http://localhost/api/v1/health
- **GeoServer**: http://localhost/geoserver

Para verificar que los 5 contenedores están arriba:

```bash
docker compose ps
```

Para ver logs en vivo mientras se prueba:

```bash
docker compose logs -f ide-app
```

> ¿Vas a levantarlo en Windows con VS Code? La guía completa (Docker Desktop,
> WSL2, troubleshooting) está en la sección
> [Solución de problemas](#solución-de-problemas) de este documento.

## Cambios recientes para levantar (diagnóstico)

Se corrigieron los siguientes bloqueos detectados en el primer arranque:

- **Migraciones:** la ruta de migraciones se corrigió a `src/db/migrations` (antes `./migrations`), por lo que las tablas del esquema `ide` se crean automáticamente.
- **Usuario administrador semilla:** se alinea con el esquema real (`ide.usuarios`, `ide.roles`, `ide.usuario_roles`) y crea una entidad por defecto si no existe.
- **Docker build:** el `Dockerfile` ya no exige `package-lock.json` (gitignored); usa `npm install --omit=dev`.
- **Docker Compose:** se eliminó el atributo `version` obsoleto.
- **Salud de GeoServer:** el health-check usa `/geoserver/` para evitar fallos por redirección.

Pasos mínimos:

```bash
cp .env.example .env   # editar JWT_SECRET, ADMIN_PASSWORD, POSTGRES_PASSWORD...
docker compose up -d --build
```

Si el puerto 80 está ocupado (IIS, Skype, etc.), cambia `"80:80"` por `"8090:80"` (u otro libre) en `docker-compose.yml`.

Si `ADMIN_PASSWORD` queda vacío, la contraseña generada aparece en `docker compose logs ide-app`.

---



La pestaña **Registrar** (entrada principal del panel `/admin`) concentra todo
el registro del dato geográfico en un solo lugar. Pregunta primero
*¿archivo o servicio?* y lleva el recurso por una ficha de **7 pasos
navegables en cualquier orden**, con estado por paso y barra de progreso:

1. **Datos** — carga del archivo (pipeline GDAL en vivo) o registro del
   servicio externo.
2. **Clasificación** — tema/subtema normativo (catálogo IGN/CCIDEP) → código
   único `TTSS-ENTIDAD-NNNN`.
3. **Calidad** — reporte ISO 19157 (dato) o batería de conformidad OGC/INSPIRE
   (servicio).
4. **Catálogo de objetos** — alias y definición por campo (ISO 19110).
5. **Simbología** — estilo SLD/LYR por tipo de objeto, aplicado a la capa
   publicada.
6. **Metadatos** — formulario CCIDEP v2.2 + push a GeoNetwork.
7. **Publicación** — aprobación QA y servicios OGC (dataset), o estado y
   monitoreo (servicio).

La sección «Registros en curso» permite retomar cualquier recurso a medias.
Las pestañas clásicas (Cargas, Datasets, Servicios, Calidad, Metadatos,
Estilos…) siguen disponibles como vista de gestión avanzada — el asistente
solo ensambla las mismas APIs en un flujo guiado.

## Flujo de uso

1. **Entidades y usuarios** (pestaña Usuarios): crear la entidad (p. ej.
   `MINAM`) y un usuario con rol `publicador` (y otro `revisor_qa`).
2. **Carga**: subir un archivo geográfico. El pipeline pasa por
   `recibido → inspeccionado → convertido → validado → en_revision →
   publicado` (o `rechazado`). Formatos soportados: SHP (`.zip`), GDB, DXF,
   KML/KMZ, CSV/XLSX con coordenadas, GeoJSON, GPKG. *DWG* se rechaza con
   instrucciones de pre-conversión a DXF (limitación de GDAL).
3. **Calidad**: tres dimensiones, cada una con score 0–100:
   - **Dato (ISO 19157)** — geometrías inválidas/vacías/duplicadas, SRID,
     bbox Perú, nulos, tipos mixtos. Las fallas bloquean la publicación.
   - **Servicio** — conformidad OGC (GetCapabilities, operaciones mínimas,
     CRS, formatos, MetadataURL, bbox) y QoS contra umbrales INSPIRE. No
     bloqueante.
   - **Documentación** — completitud del metadato CCIDEP, sincronización
     GeoNetwork, catálogo 19110 presente, atributos definidos, coherencia
     dominio↔dato. No bloqueante.
4. **QA**: el rol `revisor_qa` aprueba el dataset
   (`POST /datasets/:id/aprobar`).
5. **Metadatos**: formulario CCIDEP (pre-llenado con bbox real, EPSG, URLs de
   servicios), previsualización del XML 19139 y **Push GN**. Los fallos van a
   `sync_queue` con reintento por backoff (1/5/15/60 min).
6. **Catálogo ISO 19110**: pre-generado desde el esquema real de la tabla
   PostGIS; se completan definiciones/dominios y se exporta el XML.
7. **Servicios**: las capas publicadas registran WMS/WFS automáticamente con
   snapshot de configuración. `POST /servicios/:id/restore` re-aplica el
   último snapshot; `POST /servicios/restore-all` reconstruye GeoServer
   completo. **Réplica local con failover**: un servicio externo puede tener
   una réplica cosechada por WFS a PostGIS; la URL estable pública
   `GET /api/v1/ogc/:serviceId` sirve del origen mientras esté sano y cambia
   sola a la réplica cuando el monitoreo lo marca `caido`.
8. **Monitoreo**: sonda GetCapabilities según el intervalo del servicio; tras
   3 fallos consecutivos pasa a `caido` (correo si hay SMTP + notificación en
   panel); correo de recuperación al volver.
9. **Versionamiento**: cada re-carga crea `v(N+1)`; comparación entre
   versiones y rollback desde el detalle del dataset.
10. **Auditoría**: toda acción mutante queda en `ide.audit_log`
    (tabla de solo inserción — `UPDATE`/`DELETE` revocados a nivel de base de
    datos).

## Estructura del repositorio

```
├── docker-compose.yml      # nginx + ide-app + ide-postgis + ide-geoserver + ide-gdal
├── Dockerfile              # imagen de ide-app (Node 20)
├── nginx.conf
├── server.js               # arranque: migraciones, rutas, jobs
├── src/
│   ├── config.js           # variables de entorno tipadas
│   ├── db/
│   │   ├── pool.js         # pg.Pool + helpers query/withTransaction
│   │   └── migrations/     # 001…009, aplicadas automáticamente al iniciar
│   ├── middleware/          # auth (JWT), authorize (RBAC), audit, upload, errorHandler
│   ├── routes/v1/           # 18 routers REST (ver tabla de API más abajo)
│   ├── services/            # lógica de negocio: gdal, ingest, quality, geoserver,
│   │                        # geonetwork, iso19139, iso19110, versioning, monitor,
│   │                        # mail, clasificacion
│   └── jobs/                 # healthCheckJob, syncQueueJob, backupJob, cleanupJob
└── public/
    ├── admin/                # panel (vanilla JS): asistente Registrar + gestión avanzada
    └── catalogo/              # catálogo público de descubrimiento, sin login
```

## API principal (`/api/v1`)

| Recurso | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout` |
| Entidades / Usuarios | CRUD `/entidades`, `/usuarios` |
| Responsables | `GET/POST /responsables` (multipart `resolucion` PDF), `GET /:id/resolucion`, `PUT /:id/cesar` |
| Clasificación | `GET /clasificacion/temas`, `POST /clasificacion/temas[/:tema/subtemas]` (admin), `PUT /clasificacion/:tipo/:id` (genera código único) |
| Cargas | `POST /uploads` (multipart `archivo`), `GET /uploads/:id` (polling), `GET /:id/log` |
| Datasets | `GET/POST /datasets`, `POST /:id/aprobar`, `GET /:id/versiones/comparar?a&b`, `POST /:id/versiones/:vid/rollback` |
| Calidad | `GET /calidad/upload/:id`, `GET /calidad/resumen`, `POST/GET /calidad/servicio/:id`, `POST /calidad/dataset/:id/documentacion`, `GET /calidad/dataset/:id` |
| Recursos | `GET /recursos` (ficha unificada: etapas + scores), `GET /recursos/:tipo/:id` |
| Metadatos | `POST /metadatos/dataset/:id`, `POST /metadatos/servicio/:id`, `PUT /metadatos/:id`, `GET /:id/xml`, `POST /:id/push` |
| Catálogo 19110 | `POST /catalogo-objetos/dataset/:id/pregenerar`, `.../servicio/:id/pregenerar`, `GET .../xml`, `PUT /atributos/:id`, `PUT /tipos/:id` |
| Servicios | `GET/POST /servicios`, `POST /:id/backup`, `POST /:id/restore`, `POST /restore-all`, `GET /:id/uptime` |
| Réplicas | `POST /servicios/:id/replica`, `POST .../replica/sync`, `DELETE .../replica`; consumo estable: `GET /ogc/:serviceId` (público, failover automático) |
| Estilos | `GET/POST /estilos`, `PUT /estilos/:id`, `POST /estilos/:id/asignar`, `POST/GET /estilos/:id/lyr` |
| Público | `GET /publico/recursos?q=`, `GET /publico/recursos/:tipo/:id`, `GET /publico/metadatos/:id/xml`, `GET /publico/catalogo-objetos/:tipo/:id/xml` |
| Monitoreo | `GET /monitoreo/estado`, `GET /monitoreo/servicio/:id`, `POST .../sondear` |
| Notificaciones | `GET /notificaciones`, `POST /:id/leer`, `POST /leer-todas` |
| Auditoría | `GET /auditoria` |
| Salud | `GET /health` |

## Roles

| Rol | Alcance |
|---|---|
| `admin_ide` | Acceso total al sistema |
| `admin_entidad` | Gestiona usuarios y recursos de su entidad |
| `publicador` | Cargas, metadatos y servicios de su entidad |
| `revisor_qa` | Aprobación de datasets (`en_revision → publicado`) |
| `consulta` | Solo lectura |

## Variables de entorno

Ver `.env.example` para la lista completa. Las imprescindibles para un primer
arranque:

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | Cadena de conexión a PostGIS |
| `JWT_SECRET` | Firma de tokens — **cambiar en producción** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Usuario semilla `admin_ide` |
| `GEOSERVER_URL` / `GEOSERVER_ADMIN_USER` / `GEOSERVER_ADMIN_PASSWORD` | Credenciales REST de GeoServer |
| `GEONETWORK_URL` / `USER` / `PASS` | Opcional — instancia institucional externa |
| `SMTP_HOST` / `PORT` / `USER` / `PASS` / `FROM` | Opcional — alertas de monitoreo por correo |
| `UPLOAD_DIR` / `UPLOAD_MAX_MB` | Carpeta y límite de tamaño de cargas |
| `GDAL_MODE` | `docker` (por defecto, usa `ide-gdal` vía `docker exec`) o `local` |

## Notas de seguridad para producción

- Cambiar **todas** las claves de `.env` (`JWT_SECRET`, `POSTGRES_PASSWORD`,
  `GEOSERVER_ADMIN_PASSWORD`, `ADMIN_PASSWORD`).
- Habilitar TLS en nginx (certificados institucionales).
- El socket Docker está montado en `ide-app` solo para invocar GDAL
  (`GDAL_MODE=docker`). Alternativa sin socket: usar `GDAL_MODE=local` con
  GDAL instalado en la imagen de la app.
- La UI de administración de GeoServer queda expuesta en `/geoserver/web`; en
  producción restringirla por IP en nginx.
- `ide.audit_log` tiene `UPDATE`/`DELETE` revocados a nivel de base de datos
  (migración 001) — es un registro de auditoría de solo inserción.

## Solución de problemas

### Windows + Docker Desktop

Si `docker compose up` falla con
`unable to get image ... dockerDesktopLinuxEngine ... The system cannot find the file specified`,
Docker Desktop no está corriendo o WSL2 no está configurado:

1. Abrir Docker Desktop y esperar a que el ícono de la bandeja diga
   *"Docker Desktop is running"*.
2. Si no arranca, instalar/actualizar WSL2 desde PowerShell **como
   administrador**:
   ```powershell
   wsl --install
   wsl --update
   wsl --set-default-version 2
   ```
3. En Docker Desktop → Settings → General, marcar **"Use the WSL 2 based
   engine"** y reiniciar.
4. Verificar virtualización habilitada en el Administrador de tareas →
   Rendimiento → CPU (si dice "Deshabilitada", activarla en la BIOS/UEFI:
   Intel VT-x / AMD-V).

### Otros problemas comunes

| Síntoma | Causa / solución |
|---|---|
| `bind: address already in use` en el puerto 80 | Otro servicio (IIS, Skype…) usa el puerto. Cerrarlo o cambiar `"80:80"` en `docker-compose.yml`. |
| PostGIS no conecta al arrancar | La base tarda unos segundos en inicializar; esperar y revisar `docker compose logs ide-postgis`. |
| Contenedor sale con código 1 | `docker compose logs <contenedor>` para ver el error real. |
| Quiero borrar todo y empezar de cero | `docker compose down -v && docker compose up -d --build` (borra los volúmenes con los datos). |
| Backup manual de la base | `docker compose exec ide-postgis pg_dump -U postgres ide > backup.sql` |

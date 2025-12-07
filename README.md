# Safe Pay Bot

Bot de Telegram para intermediar pagos seguros entre clientes y creadoras: bloquea saldo del cliente, asigna pedidos, libera fondos al completar y gestiona solicitudes de retirada.

## Requisitos
- Node.js 18+ y npm
- Token de bot de Telegram
- Opcional: IDs de admins (Telegram) para comandos de gestión

## Puesta en marcha
1. Instala dependencias:
   ```bash
   npm install
   ```
2. Copia y rellena las variables de entorno:
   ```bash
   cp .env.example .env
   # edita BOT_TOKEN y ADMIN_IDS
   ```
3. Arranca el bot:
   ```bash
   npm start
   ```

## Variables de entorno
- `BOT_TOKEN` (obligatorio): token del bot de Telegram.
- `ADMIN_IDS` (opcional): lista separada por comas de IDs numéricos de admins, p. ej. `123,456`.
- `DATABASE_PATH` (opcional): ruta del SQLite; por defecto `./database.db`.

## Base de datos
- SQLite se crea/actualiza automáticamente al arrancar el bot (`db.js` ejecuta migrations).
- Esquema de referencia en `schema.sql` (usuarios, pedidos, servicios, transacciones, retiradas).
- Haz copia de seguridad del fichero de base de datos antes de desplegar/actualizar.

## Scripts npm
- `npm start`: lanza el bot (`node bot.js`).

## Comandos del bot (resumen)
- Cliente: `/saldo`, `/nuevo_pedido`, `/mis_pedidos`, `/menu`.
- Creadora: `/saldo`, `/trabajos`, `/mis_servicios`, `/nuevo_servicio`, `/mi_perfil`, `/retirar`, `/menu`.
- Flujo de pedidos: el cliente elige creadora → servicio → bloquea saldo → la creadora acepta y completa (`/completar_<id>`); para videollamadas se genera enlace seguro.
- Chat anónimo por pedido: `/chat_<id>` para enviar mensajes entre cliente y creadora; `/stop_chat` para cerrarlo.
- Admin: `/admin_topup <telegramId|@username> <euros>`, `/admin_retiradas`, `/admin_retirada_ok <id>`.

## Despliegue rápido
- Opcional: usa PM2 u otro supervisor, por ejemplo:
  ```bash
  pm2 start bot.js --name safe-pay-bot
  pm2 save
  ```
- Recuerda mantener `.env` y el fichero de base de datos fuera del control de versiones.

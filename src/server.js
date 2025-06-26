import express from "express";
import cors from "cors";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import { MKR5Master } from "./mkr5-master.js";

const app = express();
const port = 3000;
app.use(cors());
app.use(express.json());

// ---------- мастер протокола ----------
const master = new MKR5Master("/dev/ttyUSB0"); // поправь порт при необходимости
const snapshot = new Map();

master.on("update", ({ addr, data }) => {
  snapshot.set(addr, { ...snapshot.get(addr), ...data });
  broadcast({ addr, ...snapshot.get(addr) });
});

// ---------- REST ----------
app.get("/api/pumps", (_req, res) => {
  res.json([...snapshot].map(([addr, s]) => ({ addr, ...s })));
});
app.get("/api/pumps/:addr", (req, res) =>
  res.json(snapshot.get(+req.params.addr) ?? {})
);
app.post("/api/pumps/:addr/reset", (req, res) => {
  master.reset(+req.params.addr);
  res.sendStatus(202);
});
app.post("/api/pumps/:addr/authorize", (req, res) => {
  const { nozzle, volume, amount } = req.body ?? {};
  master.authorize(+req.params.addr, { nozzle, volume, amount });
  res.sendStatus(202);
});
app.post("/api/pumps/:addr/stop", (req, res) => {
  master.stop(+req.params.addr);
  res.sendStatus(202);
});

// ---------- SSE поток ----------
const clients = new Set();
app.get("/api/stream", (_req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(`event: init\ndata: ${JSON.stringify([...snapshot])}\n\n`);
  clients.add(res);
  _req.on("close", () => clients.delete(res));
});
function broadcast(obj) {
  for (const c of clients)
    c.write(`event: update\ndata: ${JSON.stringify(obj)}\n\n`);
}

// ---------- Swagger ----------
const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: { title: "MKR-5 Pump API", version: "1.0.0" },
  },
  apis: ["./src/server.js"],
});
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/**
 * @swagger
 * components:
 *   parameters:
 *     addr:
 *       in: path
 *       required: true
 *       schema: { type: integer }
 *       description: Pump address (decimal 80-111)
 *
 * /api/pumps:
 *   get: { summary: Список всех колонок, responses: { 200: { description: OK } } }
 * /api/pumps/{addr}:
 *   get: { summary: Снимок колонки, parameters: [ $ref: '#/components/parameters/addr' ] }
 * /api/pumps/{addr}/reset:
 *   post: { summary: Сброс,  parameters: [ $ref: '#/components/parameters/addr' ] }
 * /api/pumps/{addr}/authorize:
 *   post:
 *     summary: Авторизовать налив
 *     parameters: [ $ref: '#/components/parameters/addr' ]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nozzle: { type: integer, example: 1 }
 *               volume: { type: integer, example: 40 }
 *               amount: { type: integer, example: 2500 }
 * /api/pumps/{addr}/stop:
 *   post: { summary: Остановить налив, parameters: [ $ref: '#/components/parameters/addr' ] }
 */

app.listen(port, () =>
  console.log(`🚀 API http://localhost:${port}   🔎 Swagger /docs`)
);

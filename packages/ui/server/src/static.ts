import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

const here = dirname(fileURLToPath(import.meta.url));

/** Locate the built SPA. The server is compiled to packages/ui/dist/server, so
 *  the SPA sits at packages/ui/dist/web. We also try a couple of relative paths
 *  for robustness. */
function findWebDist(): string | null {
  const candidates = [
    resolve(here, "..", "web"),                      // dist/server -> dist/web
    resolve(here, "..", "..", "dist", "web"),        // server/src in dev — unused at runtime
    resolve(here, "..", "..", "..", "dist", "web"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export async function registerStatic(fastify: FastifyInstance): Promise<void> {
  const root = findWebDist();
  if (!root) {
    fastify.get("/", async (_req, reply) => {
      return reply
        .code(503)
        .type("text/plain")
        .send(
          "cgrca-view: SPA bundle not found. Run `npm -w packages/ui run build:web`.",
        );
    });
    return;
  }
  await fastify.register(fastifyStatic, {
    root,
    prefix: "/",
    decorateReply: false,
  });
  // SPA fallback for client-side routing.
  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html", root);
  });
  void join;
}

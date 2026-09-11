import type { FastifyInstance } from "fastify";

interface HealthStatus {
  status: "ok" | "degraded" | "down";
  timestamp: string;
  database?: boolean;
  uptime?: number;
}

interface StatusResponse extends HealthStatus {
  services: {
    database: boolean;
    api: boolean;
  };
  version?: string;
}

export default async function healthRoutes(app: FastifyInstance) {
  // Basic health check - lightweight
  app.get("/health", async () => {
    try {
      // Quick database ping
      const startTime = Date.now();
      await app.db.query("SELECT 1");
      const dbTime = Date.now() - startTime;

      return {
        status: dbTime > 1000 ? "degraded" : "ok",
        timestamp: new Date().toISOString(),
        database: true,
      } as HealthStatus;
    } catch {
      return {
        status: "down",
        timestamp: new Date().toISOString(),
        database: false,
      } as HealthStatus;
    }
  });

  // Detailed status endpoint for public status page
  app.get("/status", async () => {
    const startTime = Date.now();
    let dbHealthy = true;
    let apiHealthy = true;

    try {
      await app.db.query("SELECT 1");
    } catch {
      dbHealthy = false;
      apiHealthy = false;
    }

    const uptime = process.uptime();
    const overallStatus = !dbHealthy ? "down" : "ok";

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: Math.floor(uptime),
      services: {
        database: dbHealthy,
        api: apiHealthy,
      },
      version: "1.0.0",
    } as StatusResponse;
  });
}

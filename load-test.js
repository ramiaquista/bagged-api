#!/usr/bin/env node
/**
 * Basic load test for Bagged API
 * Tests common endpoints at different concurrency levels
 *
 * Usage: node load-test.js <api-url> <api-key> [concurrency]
 * Example: node load-test.js https://bagged-api-production.up.railway.app sk_live_abc123 50
 */

import http from "http";

const args = process.argv.slice(2);
const API_URL = args[0] || "https://bagged-api-production.up.railway.app";
const API_KEY = args[1];
const START_CONCURRENCY = 10;
const MAX_CONCURRENCY = args[2] ? parseInt(args[2]) : 100;
const DURATION_PER_LEVEL = 15000; // 15 seconds per concurrency level

if (!API_KEY) {
  console.error("❌ Usage: node load-test.js <api-url> <api-key> [max-concurrency]");
  console.error("Example: node load-test.js https://bagged-api-production.up.railway.app sk_live_abc123 100");
  process.exit(1);
}

// Parse URL to get host and path
const url = new URL(API_URL);
const isHttps = url.protocol === "https:";
const https = await import("https");
const httpModule = isHttps ? https : http;

const endpoints = [
  "/health",
  "/status",
];

class LoadTest {
  constructor() {
    this.results = [];
    this.running = false;
    this.requestCount = 0;
    this.successCount = 0;
    this.errorCount = 0;
    this.totalTime = 0;
    this.times = [];
    this.errorCounts = {};
    this.sampleErrors = [];
  }

  async makeRequest(endpoint) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const path = endpoint.startsWith("/") ? endpoint : "/" + endpoint;

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: path,
        method: "GET",
        headers: {
          "x-api-key": API_KEY,
          "User-Agent": "Bagged-LoadTest/1.0",
        },
      };

      const req = httpModule.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          const duration = Date.now() - startTime;
          const success = res.statusCode >= 200 && res.statusCode < 400;

          this.requestCount++;
          if (success) {
            this.successCount++;
          } else {
            this.errorCount++;
            const errKey = `${res.statusCode}`;
            this.errorCounts[errKey] = (this.errorCounts[errKey] || 0) + 1;

            // Store first 3 errors for debugging
            if (this.sampleErrors.length < 3) {
              this.sampleErrors.push({
                endpoint,
                status: res.statusCode,
                body: data.substring(0, 200),
              });
            }
          }
          this.totalTime += duration;
          if (this.times.length < 100000) {
            // Avoid stack overflow with too many items
            this.times.push(duration);
          }

          resolve({ success, statusCode: res.statusCode, duration });
        });
      });

      req.on("error", (err) => {
        this.requestCount++;
        this.errorCount++;
        const errKey = "NETWORK_ERROR";
        this.errorCounts[errKey] = (this.errorCounts[errKey] || 0) + 1;
        resolve({ success: false, error: err.message, duration: Date.now() - startTime });
      });

      req.end();
    });
  }

  async runConcurrentRequests(concurrency, durationMs) {
    const startTime = Date.now();
    const queue = [];

    const worker = async () => {
      while (Date.now() - startTime < durationMs) {
        const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
        const promise = this.makeRequest(endpoint);
        queue.push(promise);

        // Wait for oldest request to complete if queue is getting too large
        if (queue.length > concurrency * 2) {
          await queue.shift();
        }
      }
    };

    // Start multiple concurrent workers
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
    await Promise.all(queue);
  }

  calculateStats() {
    if (this.times.length === 0) return {};
    const sorted = [...this.times].sort((a, b) => a - b);
    return {
      min: Math.min(...this.times),
      max: Math.max(...this.times),
      avg: Math.round(this.totalTime / this.times.length),
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }

  async run() {
    console.log("🔥 Bagged API Load Test");
    console.log(`📍 Target: ${API_URL}`);
    console.log(`⚡ Endpoints: ${endpoints.join(", ")}`);
    console.log(`⏱️  Duration: ${DURATION_PER_LEVEL / 1000}s per concurrency level\n`);

    for (let concurrency = START_CONCURRENCY; concurrency <= MAX_CONCURRENCY; concurrency *= 2) {
      console.log(`\n🚀 Running with ${concurrency} concurrent connections...`);

      // Reset for this level
      const levelStart = this.requestCount;
      const levelStartSuccess = this.successCount;
      const levelStartError = this.errorCount;
      const levelStartTimes = this.times.length;

      await this.runConcurrentRequests(concurrency, DURATION_PER_LEVEL);

      const levelRequests = this.requestCount - levelStart;
      const levelSuccess = this.successCount - levelStartSuccess;
      const levelErrors = this.errorCount - levelStartError;
      const levelTimes = this.times.slice(levelStartTimes);

      const rps = Math.round((levelRequests / DURATION_PER_LEVEL) * 1000);
      const successRate = levelRequests > 0 ? Math.round((levelSuccess / levelRequests) * 100) : 0;

      if (levelTimes.length > 0) {
        const sorted = [...levelTimes].sort((a, b) => a - b);
        const stats = {
          min: Math.min(...levelTimes),
          max: Math.max(...levelTimes),
          avg: Math.round(levelTimes.reduce((a, b) => a + b) / levelTimes.length),
          p95: sorted[Math.floor(sorted.length * 0.95)],
          p99: sorted[Math.floor(sorted.length * 0.99)],
        };

        console.log(`   ✅ Requests: ${levelRequests} (${rps} req/sec)`);
        console.log(`   📊 Success: ${levelSuccess}/${levelRequests} (${successRate}%)`);
        console.log(`   ⏱️  Response times:`);
        console.log(
          `      Min: ${stats.min}ms | Avg: ${stats.avg}ms | P95: ${stats.p95}ms | P99: ${stats.p99}ms | Max: ${stats.max}ms`,
        );

        if (levelErrors > 0) {
          console.log(`   ❌ Errors: ${levelErrors}`);
          const errorBreakdown = Object.entries(this.errorCounts)
            .map(([code, count]) => `${code}: ${count}`)
            .join(" | ");
          console.log(`      Error breakdown: ${errorBreakdown}`);
        }
      }

      if (concurrency < MAX_CONCURRENCY) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // Final summary
    console.log("\n\n📈 Overall Summary");
    console.log("═".repeat(50));
    console.log(`Total Requests: ${this.requestCount}`);
    console.log(`Successful: ${this.successCount} (${this.requestCount > 0 ? Math.round((this.successCount / this.requestCount) * 100) : 0}%)`);
    console.log(`Errors: ${this.errorCount}`);

    if (this.errorCount > 0) {
      console.log("\nError breakdown:");
      Object.entries(this.errorCounts).forEach(([code, count]) => {
        console.log(`  ${code}: ${count}`);
      });

      if (this.sampleErrors.length > 0) {
        console.log("\nSample errors:");
        this.sampleErrors.forEach((err, i) => {
          console.log(`  ${i + 1}. ${err.endpoint} → ${err.status}`);
          if (err.body) {
            console.log(`     ${err.body}`);
          }
        });
      }
    }

    if (this.times.length > 0) {
      const finalStats = this.calculateStats();
      console.log("\nResponse Time Stats (overall):");
      console.log(`   Min: ${finalStats.min}ms`);
      console.log(`   Avg: ${finalStats.avg}ms`);
      console.log(`   P95: ${finalStats.p95}ms`);
      console.log(`   P99: ${finalStats.p99}ms`);
      console.log(`   Max: ${finalStats.max}ms`);
    }

    console.log("\n" + "═".repeat(50));
    if (this.errorCount === 0) {
      console.log("✅ All tests passed! API handled the load well.\n");
    } else if (this.successCount === 0) {
      console.log("❌ All requests failed. Check API key and endpoint configuration.\n");
    } else {
      console.log(`⚠️  ${this.errorCount} errors detected. See details above.\n`);
    }
  }
}

const test = new LoadTest();
await test.run();

import { sql } from "../src/db/client.js";
import { ensurePartitions } from "../src/db/partitions.js";

const TOTAL_ROWS = 1_000_000;
const BATCH_SIZE = 10_000;
const SERVICES = ["checkout", "auth", "payments", "search", "notifications"];
const LEVELS = ["debug", "info", "warn", "error"];
const DAYS_BACK = 30; // يوزع البيانات على شهر كامل، مطابق لافتراض الـ spec

function randomTimestamp(): Date {
  const now = Date.now();
  const past = now - DAYS_BACK * 24 * 60 * 60 * 1000;
  return new Date(past + Math.random() * (now - past));
}

function csvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function ensureAllPartitions() {
  // لازم partitions لكل الشهر الماضي، مش بس اليوم الحالي (ensurePartitions العادية بتغطي كم يوم بس)
  for (let i = 0; i <= DAYS_BACK; i++) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - i);
    date.setUTCHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setUTCDate(end.getUTCDate() + 1);
    const name = `logs_${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, "0")}_${String(date.getUTCDate()).padStart(2, "0")}`;
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${name}
      PARTITION OF logs
      FOR VALUES FROM ('${date.toISOString()}') TO ('${end.toISOString()}')
    `);
  }
}

async function seed() {
  console.log(`Seeding ${TOTAL_ROWS} rows across ${DAYS_BACK} days...`);
  await ensureAllPartitions();

  const start = Date.now();

  for (let inserted = 0; inserted < TOTAL_ROWS; inserted += BATCH_SIZE) {
    const writable = await sql`
      COPY logs (ts, level, service, message, attributes)
      FROM STDIN WITH (FORMAT csv)
    `.writable();

    await new Promise<void>((resolve, reject) => {
      writable.on("error", reject);
      writable.on("finish", resolve);

      for (let i = 0; i < BATCH_SIZE; i++) {
        const ts = randomTimestamp().toISOString();
        const level = LEVELS[Math.floor(Math.random() * LEVELS.length)];
        const service = SERVICES[Math.floor(Math.random() * SERVICES.length)];
        const message = `sample log message ${inserted + i}`;
        const attrs = JSON.stringify({ user_id: String(Math.floor(Math.random() * 10000)) });

        const row =
          [csvField(ts), csvField(level), csvField(service), csvField(message), csvField(attrs)].join(",") + "\n";
        writable.write(row);
      }
      writable.end();
    });

    console.log(`  ${inserted + BATCH_SIZE} / ${TOTAL_ROWS}`);
  }

  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Done in ${seconds}s`);
  await sql.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
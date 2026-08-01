import "dotenv/config";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

export const sql = postgres(connectionString, {
  max: 10, // عدد الاتصالات بالـ pool — رح نراجعه لاحقاً وقت اختبار الأداء تحت حدود الذاكرة
});

# Log Ingestion and Query Service
A high-performance log ingestion and query service built with TypeScript, Express, PostgreSQL, Drizzle ORM, and Docker.

## Overview
This service accepts structured application logs, stores them efficiently, and provides APIs for querying and analyzing log data.

## Tech Stack
- TypeScript
- Node.js
- Express
- PostgreSQL
- Drizzle ORM
- Docker

## Project Status
🚧 In development

## Getting Started

### Prerequisites
- Node.js (v18+)
- Docker & Docker Compose

### Development Setup
1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd log-ingestion-service
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Environment Variables:**
   Create a `.env` file in the root directory:
   ```env
   PORT=8080
   DATABASE_URL=postgresql://user:password@localhost:5432/logs_db
   ```

### Run with Docker
To spin up the entire stack (App + Database):
```bash
docker compose up --build
```
The service will be available at: `http://localhost:8080`

## API

### Health Check
```http
GET /health
```
**Response:** `200 OK`

## Architecture
Coming soon.

## Database Design
Coming soon.

## Testing
Coming soon.

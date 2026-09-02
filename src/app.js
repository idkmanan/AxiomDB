import logger from '#config/logger.js';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './routes/auth.routes.js';
import usersRoutes from '#routes/users.routes.js';
import securityMiddleware from '#middleware/security.middleware.js';
import { isSecurityBypassed } from '#utils/bench-flag.js';
const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(cookieParser());

app.use(morgan('combined', {stream: { write: (message)=> logger.info(message.trim()) }}));

// ---------------------------------------------------------------------------
// Phase 0 measurement control — NOT a feature, and NOT a security decision.
//
// The as-built request path calls Arcjet's cloud API on every request
// (src/config/arcjet.js). That network round-trip dominates the latency
// distribution, so a baseline taken with it inline measures Arcjet's RTT rather
// than this application's cost. To attribute the "before" number correctly,
// Phase 0 records two runs: as-built (flag off) and control (flag on).
//
// The guard itself lives in #utils/bench-flag.js so the test asserts the real
// expression instead of re-implementing it. Phase 1 deletes both, along with
// Arcjet.
// ---------------------------------------------------------------------------
if (isSecurityBypassed(process.env)) {
  logger.warn(
    'BENCH_BYPASS_SECURITY=1 — security middleware is DISABLED. Benchmark control run only.'
  );
} else {
  app.use(securityMiddleware);
}

app.get('/', (req, res) => {
  logger.info('Hello From Acquisitions!!!');
  res.status(200).send('Hello from Acquisitions...');
});

app.get('/health', (req,res)=>{
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString(), uptime: process.uptime()});
});

app.get('/api', (req, res)=>{
  res.status(200).json({ message: 'Acquisitions API is running!' });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);

app.use((req,res) => {
  res.status(404).json({error: "Route not found"});
})

export default app;

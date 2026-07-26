import app from '#src/app.js';
import request from 'supertest';

describe('API Endpoints', ()=>{
    describe('GET /health', ()=>{
        it('should return health status', async () => {
            const response = await request(app).get('/health').expect(200);

            expect(response.body).toHaveProperty('status', 'OK');
            expect(response.body).toHaveProperty('timestamp');
            expect(response.body).toHaveProperty('uptime');
        })
    })

    describe('GET /api', ()=>{
        it('should return api status', async () => {
            const response = await request(app).get('/api').expect(200);

            expect(response.body).toHaveProperty('message', 'Acquisitions API is running!');
        })
    })

    describe('GET /nonexistant', ()=>{
        it('should return nonexistant status', async () => {
            const response = await request(app).get('/nonexistant').expect(404);

            expect(response.body).toHaveProperty('error', 'Route not found');
        })
    })
})
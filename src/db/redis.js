import Redis from 'ioredis';
import config from '../config.js';

const redis = new Redis(config.REDIS_URL || 'redis://localhost:6379');

export default redis;

import cron from 'node-cron';

import { checkRedisClusterHealth } from './utils/cache';

async function main() {
    // ! put a memory threshold with pm2

    await checkRedisClusterHealth();
    cron.schedule('* * * * *', checkRedisClusterHealth).start();
}

main();

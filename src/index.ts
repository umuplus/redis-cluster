import cron from 'node-cron';

import { checkRedisClusterHealth } from './utils/cache';

async function main() {
    cron.schedule('*/5 * * * *', checkRedisClusterHealth).start();
}

main();

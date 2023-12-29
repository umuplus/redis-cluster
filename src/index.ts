import cron from 'node-cron';

import { checkRedisClusterHealth } from './utils/cache';
import { checkRedisClusterProxy } from './utils/proxy';
import { clusterFiles } from './utils/config';

async function main() {
    // ! put a memory threshold with pm2

    cron.schedule(
        '*/5 * * * *',
        clusterFiles.nodeType === 'cache' ? checkRedisClusterHealth : checkRedisClusterProxy
    ).start();
}

main();

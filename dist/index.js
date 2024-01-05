"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_cron_1 = __importDefault(require("node-cron"));
const cache_1 = require("./utils/cache");
async function main() {
    // ! put a memory threshold with pm2
    node_cron_1.default.schedule('*/5 * * * *', cache_1.checkRedisClusterHealth).start();
}
main();

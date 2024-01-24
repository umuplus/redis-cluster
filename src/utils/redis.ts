export type RedisClusterNode = {
    id: string;
    ip: string;
    master: boolean;
    healthy: boolean;
    slaveOf?: string;
    slaves: string[];
};

export function parseRedisNodes(payload: string) {
    const rawNodes = payload.split('\n').filter((node) => node?.trim());
    const nodes = rawNodes.reduce((final: Record<string, RedisClusterNode>, node) => {
        if (node.startsWith('Warning')) return final;

        const [id, ipAddress, flags, masterId, _ping, _pong, _epoch, status] = node.split(' ');
        const [ip] = ipAddress.split(':');
        const master = masterId === '-';
        final[ip] = {
            id,
            ip,
            master,
            healthy: status === 'connected' && !flags.includes('fail'),
            slaveOf: master ? undefined : masterId,
            slaves: [],
        };
        return final;
    }, {});
    const ips = Object.keys(nodes);
    for (const ip of ips) {
        const node = nodes[ip];
        if (node.master) continue;

        const masterOfTheNodeIp = ips.find((i) => nodes[i].id === node.slaveOf);
        if (!masterOfTheNodeIp) continue;

        nodes[masterOfTheNodeIp].slaves.push(node.id);
    }
    return nodes;
}

const redisMonitorFields = ['age', 'idle', 'tot-mem'];
export function parseRedisMonitor(payload: string) {
    // ? id=6 addr=3.255.150.165:40571 fd=9 name= age=3479 idle=1 flags=S db=0 sub=0 psub=0 multi=-1 qbuf=0 qbuf-free=0 argv-mem=0 obl=0 oll=0 omem=0 tot-mem=20520 events=r cmd=replconf user=default
    // ? id=476 addr=127.0.0.1:44728 fd=20 name= age=0 idle=0 flags=N db=0 sub=0 psub=0 multi=-1 qbuf=26 qbuf-free=32742 argv-mem=10 obl=0 oll=0 omem=0 tot-mem=61466 events=r cmd=client user=default

    const monitor = {
        count: 0,
        minAge: Infinity,
        maxAge: -Infinity,
        avgAge: 0,
        minIdle: Infinity,
        maxIdle: -Infinity,
        avgIdle: 0,
        minTotMem: Infinity,
        maxTotMem: -Infinity,
        avgTotMem: 0,
    };
    for (const line of payload.split('\n')) {
        if (!line || line.startsWith('#') || line.startsWith('Warning:') || !line.includes('id='))
            continue;

        monitor.count++;
        for (const arg of line.trim().split(' ')) {
            const [key, _value] = arg.trim().split('=');
            if (!redisMonitorFields.includes(key)) continue;

            const value = parseInt(_value);
            if (isNaN(value)) continue;

            if (key === 'age') {
                monitor.minAge = Math.min(monitor.minAge, value);
                monitor.maxAge = Math.max(monitor.maxAge, value);
                monitor.avgAge += value;
            }
            if (key === 'idle') {
                monitor.minIdle = Math.min(monitor.minIdle, value);
                monitor.maxIdle = Math.max(monitor.maxIdle, value);
                monitor.avgIdle += value;
            }
            if (key === 'tot-mem') {
                monitor.minTotMem = Math.min(monitor.minTotMem, value);
                monitor.maxTotMem = Math.max(monitor.maxTotMem, value);
                monitor.avgTotMem += value;
            }
        }
    }
    if (monitor.count) {
        monitor.avgAge = Math.round(monitor.avgAge / monitor.count);
        monitor.avgIdle = Math.round(monitor.avgIdle / monitor.count);
        monitor.avgTotMem = Math.round(monitor.avgTotMem / monitor.count);
    }
    return monitor;
}

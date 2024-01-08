#!/bin/bash
{{COMMON}}

# * install redis
apt -y install redis-server redis-tools unzip git

# * listen all network interfaces
sed -i -e 's/bind 127.0.0.1 ::1/# bind 127.0.0.1 ::1/g' /etc/redis/redis.conf

# * disable protected mode, so that we can connect from outside
sed -i -e 's/protected-mode yes/protected-mode no/g' /etc/redis/redis.conf

# * enable appendonly
sed -i -e 's/appendonly no/appendonly yes/g' /etc/redis/redis.conf

# * set password
# sed -i -e 's/# requirepass foobared/requirepass {{REDIS_PASSWORD}}/g' /etc/redis/redis.conf
# sed -i -e 's/# masterauth <master-password>/masterauth {{REDIS_PASSWORD}}/g' /etc/redis/redis.conf

# * enable cluster
sed -i -e 's/# cluster-enabled yes/cluster-enabled yes/g' /etc/redis/redis.conf
echo 'bind 0.0.0.0' >> /etc/redis/redis.conf

service redis restart

runuser -l ubuntu -c 'curl -o- https://raw.githubusercontent.com/umuplus/redis-cluster/main/scripts/install.sh | bash'

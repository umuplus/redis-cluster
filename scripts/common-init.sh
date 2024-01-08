export REDIS_CLUSTER_FILES=/home/ubuntu/cluster-files

mkdir -p $REDIS_CLUSTER_FILES

read -r -d '' REDIS_CLUSTER_PRIVATE_KEY << EOM
{{PRIVATE_KEY}}
EOM

echo "$REDIS_CLUSTER_PRIVATE_KEY" > $REDIS_CLUSTER_FILES/key.pem
chmod 400 $REDIS_CLUSTER_FILES/key.pem

read -r -d '' REDIS_CLUSTER_PUBLIC_KEY << EOM
{{PUBLIC_KEY}}
EOM
echo "$REDIS_CLUSTER_PUBLIC_KEY" > $REDIS_CLUSTER_FILES/key.pub

read -r -d '' CREDENTIALS << EOM
{{CREDENTIALS}}
EOM
echo "$CREDENTIALS" > $REDIS_CLUSTER_FILES/credentials.json

echo "{{REDIS_PASSWORD}}" > $REDIS_CLUSTER_FILES/password
echo "{{CLUSTER_REPLICAS}}" > $REDIS_CLUSTER_FILES/replicas
echo "{{NODE_TYPE}}" > $REDIS_CLUSTER_FILES/node-type

chown -Rf ubuntu:ubuntu $REDIS_CLUSTER_FILES
chmod -Rf 755 $REDIS_CLUSTER_FILES

# TODO! increase open file limit https://manishrjain.com/increase-open-file-limits-ubuntu

# * update apt
apt -y update

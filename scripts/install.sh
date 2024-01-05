#! /bin/bash

set -e

cd ~

echo "installing nvm"
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

echo "installing node"
nvm install 18

echo "installing pm2"
npm install -g pm2

git clone https://github.com/umuplus/redis-cluster.git
cd redis-cluster

npm install
# npm run build

echo "starting pm2"
pm2 startup | bash
pm2 start dist/index.js
pm2 save

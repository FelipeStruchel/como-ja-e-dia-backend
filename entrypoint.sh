#!/bin/sh
set -e
./node_modules/.bin/prisma db push --accept-data-loss
if [ -f prisma/seed.js ]; then
  node prisma/seed.js
fi
exec npm start

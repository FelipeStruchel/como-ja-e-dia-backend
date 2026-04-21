#!/bin/sh
set -e
./node_modules/.bin/prisma db push --accept-data-loss
node prisma/seed.js
exec npm start

#!/bin/sh
set -e
./node_modules/.bin/prisma db push
exec npm start

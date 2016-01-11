#!/bin/sh

tail -500f /var/log/ungit/forever.log | perl -ple 's/verbose:/\e[1;34m$&\e[0m/g || s/info:/\e[1;32m$&\e[0m/g || s/warn:/\e[1;33m$&\e[0m/g || s/debug:/\e[1;35m$&\e[0m/g || s/error:/\e[1;31m$&\e[0m/g'
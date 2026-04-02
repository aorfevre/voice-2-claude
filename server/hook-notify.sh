#!/bin/bash
# Reads Claude Code hook JSON from stdin, forwards to Terminal Remote server
INPUT=$(cat)
curl -s -X POST http://localhost:9000/api/hook \
  -H 'Content-Type: application/json' \
  -H "X-Hook-Event: $1" \
  -d "$INPUT" &

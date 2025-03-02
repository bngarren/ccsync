#!/bin/bash

# Define the log file path
LOG_FILE="/Users/bngarren/Library/Logs/ccsync/current.log"

# Check if the log file exists
if [ ! -f "$LOG_FILE" ]; then
    echo "Error: Log file does not exist: $LOG_FILE"
    exit 1
fi

# Run the tail command and pipe it to pino-pretty
echo "Tailing log file: $LOG_FILE"
tail -f "$LOG_FILE" | pino-pretty -c -l -i pid,hostname,component -S -o '{if component} [{component}]: {end}{msg}'
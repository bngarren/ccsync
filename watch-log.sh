#!/bin/bash

# Default log file directory
DEFAULT_LOG_DIR="/Users/bngarren/Library/Logs/ccsync"

# Default log file path
LOG_FILE="$DEFAULT_LOG_DIR/current.log"

# Function to display usage
usage() {
    echo "Usage: $0 [-F | --file <log_file>]"
    exit 1
}

# Check if the path is absolute
is_absolute_path() {
    [[ "$1" =~ ^/ ]]
}

# Parse command-line arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        -F|--file)
            if [[ -n "$2" && ! "$2" =~ ^- ]]; then
                # Check if the provided path is absolute
                if is_absolute_path "$2"; then
                    LOG_FILE="$2"
                else
                    LOG_FILE="$DEFAULT_LOG_DIR/$2"
                fi
                shift 2
            else
                echo "Error: Missing value for the --file/-F flag."
                usage
            fi
            ;;
        *)
            echo "Error: Invalid argument $1"
            usage
            ;;
    esac
done

# Check if the log file exists
if [ ! -f "$LOG_FILE" ]; then
    echo "Error: Log file does not exist: $LOG_FILE"
    exit 1
fi

# Run the tail command and pipe it to pino-pretty
echo "Tailing log file: $LOG_FILE"
tail -f "$LOG_FILE" | pino-pretty -c -i pid,hostname,component -S -o '{if component} [{component}]: {end}{msg}'

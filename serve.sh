#!/usr/bin/env bash
#
# Local dev server for the reading app.
#
#   ./serve.sh            start, then open a browser tab
#   ./serve.sh stop       stop the server this script started
#   ./serve.sh kill       free the port, whoever is holding it
#   ./serve.sh restart    stop, start, open
#   ./serve.sh status     is it running, and on what
#
# Port defaults to 8000; override with PORT=1234 ./serve.sh
# The site needs a real origin — ES modules and fetch do not work over file://.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8000}"
PIDFILE="$ROOT/.serve.pid"
LOGFILE="$ROOT/.serve.log"
URL="http://localhost:$PORT/"

# Is the process named by the PID file actually alive?
running() {
  [[ -f "$PIDFILE" ]] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# Anything at all bound to the port, ours or not.
port_pid() {
  lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1
}

open_tab() {
  if command -v open >/dev/null 2>&1; then
    open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1
  else
    echo "Open $URL in your browser."
  fi
}

start() {
  if running; then
    echo "Already running on $URL (pid $(cat "$PIDFILE"))."
    open_tab
    return 0
  fi

  # Port taken by something that is not us — say whose it is rather than
  # failing with a bare "address already in use".
  local other
  other="$(port_pid || true)"
  if [[ -n "$other" ]]; then
    echo "Port $PORT is already in use by pid $other ($(ps -p "$other" -o comm= 2>/dev/null || echo unknown))." >&2
    echo "Free it with:          $0 kill" >&2
    echo "Or use another port:   PORT=8081 $0" >&2
    return 1
  fi

  cd "$ROOT"
  python3 -m http.server "$PORT" >"$LOGFILE" 2>&1 &
  echo $! >"$PIDFILE"

  # Wait for it to actually accept connections before opening the tab,
  # otherwise the browser races the server and shows a connection error.
  local i
  for i in $(seq 1 40); do
    if curl -fsS -o /dev/null "$URL" 2>/dev/null; then
      echo "Serving $ROOT on $URL (pid $(cat "$PIDFILE"))"
      open_tab
      return 0
    fi
    sleep 0.1
  done

  echo "Server did not come up within 4s. Last output:" >&2
  tail -5 "$LOGFILE" >&2 || true
  stop >/dev/null 2>&1 || true
  return 1
}

stop() {
  if running; then
    local pid
    pid="$(cat "$PIDFILE")"
    kill "$pid" 2>/dev/null || true
    # Give it a moment, then insist.
    local i
    for i in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
    echo "Stopped (pid $pid)."
  else
    rm -f "$PIDFILE"
    echo "Not running."
  fi
}

# Free the port regardless of who owns it. Separate from `stop` on purpose:
# stop only ever touches the process this script started, whereas this will
# terminate someone else's — so it says what it is about to kill first.
force_kill() {
  local pid
  pid="$(port_pid || true)"

  if [[ -z "$pid" ]]; then
    rm -f "$PIDFILE"
    echo "Nothing is listening on port $PORT."
    return 0
  fi

  local cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || echo 'unknown process')"
  echo "Port $PORT is held by pid $pid:"
  echo "  $cmd"

  kill "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "  did not exit on TERM, sending KILL"
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.2
  fi

  # Only clear our PID file if it referred to the process we just killed.
  if [[ -f "$PIDFILE" ]] && [[ "$(cat "$PIDFILE" 2>/dev/null)" == "$pid" ]]; then
    rm -f "$PIDFILE"
  fi

  if [[ -n "$(port_pid || true)" ]]; then
    echo "Port $PORT is still in use." >&2
    return 1
  fi
  echo "Port $PORT is free."
}

status() {
  if running; then
    echo "Running on $URL (pid $(cat "$PIDFILE"))"
  else
    local other
    other="$(port_pid || true)"
    if [[ -n "$other" ]]; then
      echo "Not started by this script, but port $PORT is held by pid $other."
    else
      echo "Not running."
    fi
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  kill) force_kill ;;
  restart)
    # Take the port back even if the previous server was started by hand.
    if running; then stop; else force_kill; fi
    start
    ;;
  status) status ;;
  *)
    echo "usage: $0 [start|stop|kill|restart|status]" >&2
    exit 2
    ;;
esac

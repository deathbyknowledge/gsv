#!/usr/bin/env bash

wait_for_http_contains() {
  local url="$1"
  local expected="$2"
  local timeout_seconds="$3"
  local deadline=$((SECONDS + timeout_seconds))
  local response_file="${RUNTIME_DIR}/http-response.tmp"

  while ((SECONDS < deadline)); do
    if curl --fail --silent --show-error \
      --connect-timeout 5 \
      --max-time 10 \
      "${url}" >"${response_file}" 2>/dev/null \
      && grep -Fq -- "${expected}" "${response_file}"; then
      rm -f "${response_file}"
      return 0
    fi
    sleep 1
  done
  rm -f "${response_file}"
  return 1
}

wait_for_http_ok() {
  local url="$1"
  local timeout_seconds="$2"
  local deadline=$((SECONDS + timeout_seconds))

  while ((SECONDS < deadline)); do
    if curl --fail --silent --show-error \
      --output /dev/null \
      --connect-timeout 5 \
      --max-time 10 \
      "${url}" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_log_marker() {
  local path="$1"
  local marker="$2"
  local pid="$3"
  local timeout_seconds="$4"
  local deadline=$((SECONDS + timeout_seconds))

  while ((SECONDS < deadline)); do
    if [[ -f "${path}" ]] && grep -Fq -- "${marker}" "${path}"; then
      return 0
    fi
    if ! kill -0 "${pid}" 2>/dev/null; then
      return 1
    fi
    sleep 1
  done
  return 1
}

wait_for_command_marker() {
  local marker="$1"
  local timeout_seconds="$2"
  local output_file="$3"
  shift 3
  local deadline=$((SECONDS + timeout_seconds))
  local temporary="${output_file}.tmp"

  while ((SECONDS < deadline)); do
    if "$@" >"${temporary}" 2>&1; then
      mv -f "${temporary}" "${output_file}"
      if grep -Fq -- "${marker}" "${output_file}"; then
        rm -f "${output_file}"
        return 0
      fi
    else
      rm -f "${temporary}"
    fi
    sleep 1
  done
  rm -f "${temporary}" "${output_file}"
  return 1
}

find_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

stop_child() {
  local pid="$1"
  local label="$2"
  local deadline
  if [[ -z "${pid}" ]] || ! kill -0 "${pid}" 2>/dev/null; then
    return 0
  fi

  printf 'Stopping %s...\n' "${label}"
  kill -TERM "${pid}" 2>/dev/null || true
  deadline=$((SECONDS + 8))
  while ((SECONDS < deadline)); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      wait "${pid}" 2>/dev/null || true
      return 0
    fi
    sleep 0.2
  done
  kill -KILL "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null || true
}

extract_issued_token() {
  local path="$1"
  local token
  token="$(sed -n 's/^token: //p' "${path}" | tail -n 1)"
  if [[ -z "${token}" || "${token}" == *[[:space:]]* ]]; then
    return 1
  fi
  printf '%s' "${token}"
}

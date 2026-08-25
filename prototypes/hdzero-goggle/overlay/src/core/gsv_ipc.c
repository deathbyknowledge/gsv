#include "gsv_ipc.h"

#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define GSV_DEFAULT_SOCKET "/tmp/gsv-hdzero.sock"
#define GSV_LINE_MAX       32768

enum {
    COMMAND_NONE = 0,
    COMMAND_VOICE,
    COMMAND_SPEECH,
    COMMAND_CANCEL,
    COMMAND_VIEW_NEXT,
    COMMAND_VIEW_PREVIOUS,
};

#define COMMAND_QUEUE_MAX 16

static pthread_mutex_t state_mutex = PTHREAD_MUTEX_INITIALIZER;
static gsv_snapshot_t latest = {
    .version = 1,
    .view = "conversation",
    .client_connection = "offline",
    .driver_connection = "offline",
    .device_id = "hdzero-g2-emulator",
    .phase = "idle",
    .status = "Bridge offline",
    .activity = "Wearable bridge offline",
    .presentation_kind = "none",
};
static uint8_t command_queue[COMMAND_QUEUE_MAX];
static size_t command_queue_head;
static size_t command_queue_count;
static bool thread_started;

static void copy_string(char *destination, size_t size, const char *source) {
    if (size == 0) {
        return;
    }
    snprintf(destination, size, "%s", source ? source : "");
}

static int hex_value(char value) {
    if (value >= '0' && value <= '9') {
        return value - '0';
    }
    if (value >= 'a' && value <= 'f') {
        return value - 'a' + 10;
    }
    if (value >= 'A' && value <= 'F') {
        return value - 'A' + 10;
    }
    return -1;
}

static size_t append_utf8(char *output, size_t offset, size_t size, uint32_t codepoint) {
    unsigned char bytes[4];
    size_t count;
    if (codepoint <= 0x7f) {
        bytes[0] = (unsigned char)codepoint;
        count = 1;
    } else if (codepoint <= 0x7ff) {
        bytes[0] = (unsigned char)(0xc0 | (codepoint >> 6));
        bytes[1] = (unsigned char)(0x80 | (codepoint & 0x3f));
        count = 2;
    } else {
        bytes[0] = (unsigned char)(0xe0 | (codepoint >> 12));
        bytes[1] = (unsigned char)(0x80 | ((codepoint >> 6) & 0x3f));
        bytes[2] = (unsigned char)(0x80 | (codepoint & 0x3f));
        count = 3;
    }
    for (size_t i = 0; i < count && offset + 1 < size; ++i) {
        output[offset++] = (char)bytes[i];
    }
    return offset;
}

static bool json_string(const char *json, const char *key, char *output, size_t size) {
    char pattern[80];
    snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
    const char *cursor = strstr(json, pattern);
    if (!cursor || size == 0) {
        return false;
    }
    cursor += strlen(pattern);
    size_t offset = 0;
    while (*cursor && *cursor != '"') {
        unsigned char value = (unsigned char)*cursor++;
        if (value == '\\') {
            char escaped = *cursor++;
            switch (escaped) {
            case 'n': value = '\n'; break;
            case 'r': value = '\r'; break;
            case 't': value = '\t'; break;
            case 'b': value = '\b'; break;
            case 'f': value = '\f'; break;
            case '"': value = '"'; break;
            case '\\': value = '\\'; break;
            case '/': value = '/'; break;
            case 'u': {
                uint32_t codepoint = 0;
                for (int i = 0; i < 4; ++i) {
                    int nibble = hex_value(cursor[i]);
                    if (nibble < 0) {
                        output[offset] = '\0';
                        return false;
                    }
                    codepoint = (codepoint << 4) | (uint32_t)nibble;
                }
                cursor += 4;
                offset = append_utf8(output, offset, size, codepoint);
                continue;
            }
            default:
                output[offset] = '\0';
                return false;
            }
        }
        if (offset + 1 < size) {
            output[offset++] = (char)value;
        }
    }
    if (*cursor != '"') {
        output[offset] = '\0';
        return false;
    }
    output[offset] = '\0';
    return true;
}

static bool json_bool(const char *json, const char *key, bool *output) {
    char pattern[80];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char *cursor = strstr(json, pattern);
    if (!cursor) {
        return false;
    }
    cursor += strlen(pattern);
    if (strncmp(cursor, "true", 4) == 0) {
        *output = true;
        return true;
    }
    if (strncmp(cursor, "false", 5) == 0) {
        *output = false;
        return true;
    }
    return false;
}

static void publish_snapshot(const char *line) {
    char type[32];
    gsv_snapshot_t next = {0};
    if (!json_string(line, "type", type, sizeof(type)) ||
        strcmp(type, "wearable.snapshot") != 0) {
        return;
    }
    if (!json_string(line, "view", next.view, sizeof(next.view)) ||
        !json_string(line, "clientConnection", next.client_connection,
                     sizeof(next.client_connection)) ||
        !json_string(line, "driverConnection", next.driver_connection,
                     sizeof(next.driver_connection)) ||
        !json_string(line, "phase", next.phase, sizeof(next.phase))) {
        return;
    }
    json_bool(line, "speak", &next.speak);
    json_string(line, "deviceId", next.device_id, sizeof(next.device_id));
    json_string(line, "status", next.status, sizeof(next.status));
    json_string(line, "activity", next.activity, sizeof(next.activity));
    json_string(line, "presentationKind", next.presentation_kind,
                sizeof(next.presentation_kind));
    json_string(line, "presentationTitle", next.presentation_title,
                sizeof(next.presentation_title));
    json_string(line, "presentationBody", next.presentation_body,
                sizeof(next.presentation_body));
    json_string(line, "presentationPath", next.presentation_path,
                sizeof(next.presentation_path));
    json_string(line, "transcript", next.transcript, sizeof(next.transcript));
    json_string(line, "answer", next.answer, sizeof(next.answer));
    json_string(line, "error", next.error, sizeof(next.error));
    json_string(line, "runId", next.run_id, sizeof(next.run_id));

    pthread_mutex_lock(&state_mutex);
    next.version = latest.version + 1;
    latest = next;
    pthread_mutex_unlock(&state_mutex);
}

static void publish_offline(void) {
    pthread_mutex_lock(&state_mutex);
    if (strcmp(latest.client_connection, "offline") != 0 ||
        strcmp(latest.driver_connection, "offline") != 0 ||
        strcmp(latest.status, "Bridge offline") != 0) {
        copy_string(latest.client_connection, sizeof(latest.client_connection), "offline");
        copy_string(latest.driver_connection, sizeof(latest.driver_connection), "offline");
        copy_string(latest.phase, sizeof(latest.phase), "idle");
        copy_string(latest.status, sizeof(latest.status), "Bridge offline");
        copy_string(latest.activity, sizeof(latest.activity), "Wearable bridge offline");
        latest.run_id[0] = '\0';
        ++latest.version;
    }
    pthread_mutex_unlock(&state_mutex);
}

static uint8_t peek_command(void) {
    pthread_mutex_lock(&state_mutex);
    uint8_t command = command_queue_count ? command_queue[command_queue_head] : COMMAND_NONE;
    pthread_mutex_unlock(&state_mutex);
    return command;
}

static void pop_command(void) {
    pthread_mutex_lock(&state_mutex);
    if (command_queue_count) {
        command_queue_head = (command_queue_head + 1) % COMMAND_QUEUE_MAX;
        --command_queue_count;
    }
    pthread_mutex_unlock(&state_mutex);
}

static bool send_action(int fd, const char *action) {
    char line[96];
    int length = snprintf(line, sizeof(line), "{\"type\":\"%s\"}\n", action);
    if (length <= 0 || (size_t)length >= sizeof(line)) {
        return false;
    }
    ssize_t written = send(fd, line, (size_t)length, MSG_NOSIGNAL);
    return written == length;
}

static bool flush_commands(int fd) {
    for (;;) {
        uint8_t command = peek_command();
        if (command == COMMAND_NONE) {
            return true;
        }
        const char *name = command == COMMAND_VOICE ? "voice.toggle"
                           : command == COMMAND_SPEECH ? "speech.toggle"
                           : command == COMMAND_CANCEL ? "request.cancel"
                           : command == COMMAND_VIEW_NEXT ? "view.next"
                                                          : "view.previous";
        if (!send_action(fd, name)) {
            return false;
        }
        pop_command();
    }
}

static int connect_bridge(void) {
    const char *path = getenv("GSV_HDZERO_SOCKET");
    if (!path || !*path) {
        path = GSV_DEFAULT_SOCKET;
    }
    if (strlen(path) >= sizeof(((struct sockaddr_un *)0)->sun_path)) {
        return -1;
    }
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        return -1;
    }
    struct sockaddr_un address = {0};
    address.sun_family = AF_UNIX;
    copy_string(address.sun_path, sizeof(address.sun_path), path);
    if (connect(fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
        close(fd);
        return -1;
    }
    return fd;
}

static void consume_bytes(char *line, size_t *line_length, bool *overflow,
                          const char *bytes, size_t count) {
    for (size_t i = 0; i < count; ++i) {
        char value = bytes[i];
        if (value == '\n') {
            if (!*overflow && *line_length > 0) {
                line[*line_length] = '\0';
                publish_snapshot(line);
            }
            *line_length = 0;
            *overflow = false;
        } else if (!*overflow) {
            if (*line_length + 1 < GSV_LINE_MAX) {
                line[(*line_length)++] = value;
            } else {
                *overflow = true;
                *line_length = 0;
            }
        }
    }
}

static void *ipc_thread(void *unused) {
    (void)unused;
    char line[GSV_LINE_MAX];
    char buffer[2048];
    size_t line_length = 0;
    bool overflow = false;

    for (;;) {
        int fd = connect_bridge();
        if (fd < 0) {
            publish_offline();
            sleep(1);
            continue;
        }
        line_length = 0;
        overflow = false;
        for (;;) {
            if (!flush_commands(fd)) {
                break;
            }
            struct pollfd poll_fd = {.fd = fd, .events = POLLIN | POLLHUP | POLLERR};
            int result = poll(&poll_fd, 1, 100);
            if (result < 0 && errno == EINTR) {
                continue;
            }
            if (result < 0 || (poll_fd.revents & (POLLHUP | POLLERR))) {
                break;
            }
            if (result > 0 && (poll_fd.revents & POLLIN)) {
                ssize_t count = recv(fd, buffer, sizeof(buffer), 0);
                if (count == 0) {
                    break;
                }
                if (count < 0) {
                    if (errno == EINTR) {
                        continue;
                    }
                    break;
                }
                if (count > 0) {
                    consume_bytes(line, &line_length, &overflow, buffer, (size_t)count);
                }
            }
        }
        close(fd);
        publish_offline();
        usleep(250000);
    }
    return NULL;
}

void gsv_ipc_init(void) {
    pthread_mutex_lock(&state_mutex);
    if (thread_started) {
        pthread_mutex_unlock(&state_mutex);
        return;
    }
    thread_started = true;
    pthread_mutex_unlock(&state_mutex);

    pthread_t thread;
    if (pthread_create(&thread, NULL, ipc_thread, NULL) == 0) {
        pthread_detach(thread);
    } else {
        pthread_mutex_lock(&state_mutex);
        thread_started = false;
        copy_string(latest.status, sizeof(latest.status), "Bridge thread failed");
        ++latest.version;
        pthread_mutex_unlock(&state_mutex);
    }
}

void gsv_ipc_copy_snapshot(gsv_snapshot_t *snapshot) {
    if (!snapshot) {
        return;
    }
    pthread_mutex_lock(&state_mutex);
    *snapshot = latest;
    pthread_mutex_unlock(&state_mutex);
}

void gsv_ipc_send_action(const char *action) {
    uint8_t value = COMMAND_NONE;
    if (strcmp(action, "voice.toggle") == 0) {
        value = COMMAND_VOICE;
    } else if (strcmp(action, "speech.toggle") == 0) {
        value = COMMAND_SPEECH;
    } else if (strcmp(action, "request.cancel") == 0) {
        value = COMMAND_CANCEL;
    } else if (strcmp(action, "view.next") == 0) {
        value = COMMAND_VIEW_NEXT;
    } else if (strcmp(action, "view.previous") == 0) {
        value = COMMAND_VIEW_PREVIOUS;
    }
    if (value == COMMAND_NONE) {
        return;
    }
    pthread_mutex_lock(&state_mutex);
    if (command_queue_count == COMMAND_QUEUE_MAX && value == COMMAND_CANCEL) {
        command_queue_head = 0;
        command_queue_count = 0;
    }
    if (command_queue_count < COMMAND_QUEUE_MAX) {
        size_t tail = (command_queue_head + command_queue_count) % COMMAND_QUEUE_MAX;
        command_queue[tail] = value;
        ++command_queue_count;
    }
    pthread_mutex_unlock(&state_mutex);
}

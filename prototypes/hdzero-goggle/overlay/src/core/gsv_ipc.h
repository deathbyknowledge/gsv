#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GSV_TRANSCRIPT_MAX 2048
#define GSV_ANSWER_MAX     8192
#define GSV_ERROR_MAX      512

typedef struct {
    uint64_t version;
    bool speak;
    char connection[16];
    char phase[24];
    char status[128];
    char transcript[GSV_TRANSCRIPT_MAX];
    char answer[GSV_ANSWER_MAX];
    char error[GSV_ERROR_MAX];
    char run_id[96];
} gsv_snapshot_t;

void gsv_ipc_init(void);
void gsv_ipc_copy_snapshot(gsv_snapshot_t *snapshot);
void gsv_ipc_send_command(const char *command);

#ifdef __cplusplus
}
#endif

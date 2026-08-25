#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GSV_TRANSCRIPT_MAX 2048
#define GSV_ANSWER_MAX     8192
#define GSV_ERROR_MAX      512
#define GSV_ACTIVITY_MAX   192
#define GSV_PRESENTATION_BODY_MAX 6144
#define GSV_PRESENTATION_PATH_MAX  800

typedef struct {
    uint64_t version;
    bool speak;
    char view[16];
    char client_connection[16];
    char driver_connection[16];
    char device_id[96];
    char phase[24];
    char status[128];
    char activity[GSV_ACTIVITY_MAX];
    char presentation_kind[16];
    char presentation_title[128];
    char presentation_body[GSV_PRESENTATION_BODY_MAX];
    char presentation_path[GSV_PRESENTATION_PATH_MAX];
    char transcript[GSV_TRANSCRIPT_MAX];
    char answer[GSV_ANSWER_MAX];
    char error[GSV_ERROR_MAX];
    char run_id[96];
} gsv_snapshot_t;

void gsv_ipc_init(void);
void gsv_ipc_copy_snapshot(gsv_snapshot_t *snapshot);
void gsv_ipc_send_action(const char *action);

#ifdef __cplusplus
}
#endif

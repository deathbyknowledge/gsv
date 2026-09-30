#ifndef GSV_LITERT_BRIDGE_H
#define GSV_LITERT_BRIDGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct GsvLiteRtModel GsvLiteRtModel;
typedef void (*GsvLiteRtProfileCallback)(void* context, const char* operation,
                                         int64_t node, uint64_t microseconds);

// Each handle owns its model bytes, interpreter, delegate and tensor buffers.
// A handle may move between threads, but callers must serialize its use.
GsvLiteRtModel* gsv_litert_create(const uint8_t* model, size_t model_size,
                                  size_t input_size, const size_t* output_sizes,
                                  size_t output_count, int threads,
                                  bool profile);
void gsv_litert_destroy(GsvLiteRtModel* model);
bool gsv_litert_run(GsvLiteRtModel* model, const float* input,
                    size_t input_size, float* output, size_t output_size);
bool gsv_litert_profile(GsvLiteRtModel* model,
                        GsvLiteRtProfileCallback callback, void* context);

#ifdef __cplusplus
}
#endif
#endif

#include "bridge.h"

#include <cstdarg>
#include <cstring>
#include <memory>
#include <mutex>
#include <numeric>
#include <vector>

#include "tflite/core/api/error_reporter.h"
#include "tflite/delegates/xnnpack/xnnpack_delegate.h"
#include "tflite/interpreter.h"
#include "tflite/kernels/register.h"
#include "tflite/minimal_logging.h"
#include "tflite/model_builder.h"
#include "tflite/profiling/buffered_profiler.h"

namespace {
class QuietReporter final : public tflite::ErrorReporter {
 public:
  int Report(const char*, va_list) override { return 0; }
};

bool float_tensor(const TfLiteTensor* tensor, size_t size) {
  return tensor != nullptr && tensor->type == kTfLiteFloat32 &&
         tensor->bytes == size * sizeof(float);
}
}  // namespace

struct GsvLiteRtModel {
  QuietReporter reporter;
  std::vector<uint8_t> bytes;
  std::unique_ptr<tflite::FlatBufferModel> model;
  std::unique_ptr<TfLiteDelegate, decltype(&TfLiteXNNPackDelegateDelete)>
      delegate{nullptr, TfLiteXNNPackDelegateDelete};
  std::unique_ptr<tflite::profiling::BufferedProfiler> profiler;
  // Destruction order keeps the delegate, profiler and model alive until the
  // interpreter has released every reference to them.
  std::unique_ptr<tflite::Interpreter> interpreter;
  size_t input_size;
  std::vector<size_t> output_sizes;
  size_t output_size;
};

extern "C" GsvLiteRtModel* gsv_litert_create(const uint8_t* bytes, size_t size,
                                             size_t input_size,
                                             const size_t* output_sizes,
                                             size_t output_count, int threads,
                                             bool profile) {
  try {
    static std::once_flag logging;
    std::call_once(logging, [] {
      tflite::logging_internal::MinimalLogger::SetMinimumLogSeverity(
          tflite::TFLITE_LOG_SILENT);
    });
    auto result = std::make_unique<GsvLiteRtModel>();
    result->bytes.assign(bytes, bytes + size);
    result->input_size = input_size;
    result->output_sizes.assign(output_sizes, output_sizes + output_count);
    result->output_size = std::accumulate(
        result->output_sizes.begin(), result->output_sizes.end(), size_t{0});
    result->model = tflite::FlatBufferModel::VerifyAndBuildFromBuffer(
        reinterpret_cast<const char*>(result->bytes.data()), size, nullptr,
        &result->reporter);
    if (!result->model) return nullptr;
    tflite::ops::builtin::BuiltinOpResolverWithoutDefaultDelegates resolver;
    if (tflite::InterpreterBuilder(*result->model, resolver)(
            &result->interpreter, threads) != kTfLiteOk)
      return nullptr;
    if (profile) {
      result->profiler =
          std::make_unique<tflite::profiling::BufferedProfiler>(1024);
      result->interpreter->SetProfiler(result->profiler.get());
    }
    auto options = TfLiteXNNPackDelegateOptionsDefault();
    options.num_threads = threads;
    result->delegate.reset(TfLiteXNNPackDelegateCreate(&options));
    if (!result->delegate ||
        result->interpreter->ModifyGraphWithDelegate(result->delegate.get()) !=
            kTfLiteOk ||
        result->interpreter->AllocateTensors() != kTfLiteOk)
      return nullptr;
    // Both pinned models must actually execute on XNNPACK. A silent fallback
    // would hide a broken release configuration or an unsupported model update.
    const auto& plan = result->interpreter->execution_plan();
    if (plan.empty()) return nullptr;
    for (int node : plan) {
      if (result->interpreter->node_and_registration(node)->first.delegate !=
          result->delegate.get())
        return nullptr;
    }
    if (result->interpreter->inputs().size() != 1 ||
        result->interpreter->outputs().size() != output_count ||
        !float_tensor(result->interpreter->input_tensor(0), input_size)) {
      return nullptr;
    }
    for (size_t i = 0; i < output_count; ++i) {
      if (!float_tensor(result->interpreter->output_tensor(i),
                        output_sizes[i])) {
        return nullptr;
      }
    }
    return result.release();
  } catch (...) {
    return nullptr;
  }
}

extern "C" void gsv_litert_destroy(GsvLiteRtModel* model) { delete model; }

extern "C" bool gsv_litert_run(GsvLiteRtModel* model, const float* input,
                               size_t input_size, float* output,
                               size_t output_size) {
  try {
    if (input_size != model->input_size || output_size != model->output_size) {
      return false;
    }
    if (model->profiler) {
      model->profiler->Reset();
      model->profiler->StartProfiling();
    }
    std::memcpy(model->interpreter->typed_input_tensor<float>(0), input,
                input_size * sizeof(float));
    auto status = model->interpreter->Invoke();
    if (model->profiler) model->profiler->StopProfiling();
    if (status != kTfLiteOk) return false;
    for (size_t i = 0; i < model->output_sizes.size(); ++i) {
      const size_t size = model->output_sizes[i];
      std::memcpy(output, model->interpreter->typed_output_tensor<float>(i),
                  size * sizeof(float));
      output += size;
    }
    return true;
  } catch (...) {
    return false;
  }
}

extern "C" bool gsv_litert_profile(GsvLiteRtModel* model,
                                   GsvLiteRtProfileCallback callback,
                                   void* context) {
  try {
    if (!model->profiler) return false;
    for (const auto* event : model->profiler->GetProfileEvents()) {
      // XNNPACK emits individual operator timings inside its enclosing delegate
      // event. Include only the former so profiling never counts work twice.
      if (event->event_type == tflite::Profiler::EventType::
                                   DELEGATE_PROFILED_OPERATOR_INVOKE_EVENT) {
        callback(context, event->tag.c_str(), event->event_metadata,
                 event->elapsed_time);
      }
    }
    return true;
  } catch (...) {
    return false;
  }
}

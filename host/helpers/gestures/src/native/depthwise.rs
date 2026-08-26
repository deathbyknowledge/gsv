use tract_tflite::internal::tract_core::ops::cnn::conv::{Conv, KernelFormat};
use tract_tflite::internal::tract_core::ops::cnn::PoolSpec;
use tract_tflite::internal::tract_core::ops::nn::DataFormat;
use tract_tflite::internal::*;

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct ChannelDepthWise {
    pool_spec: PoolSpec,
}

impl Op for ChannelDepthWise {
    fn name(&self) -> StaticName {
        "ChannelDepthWiseConv".into()
    }

    fn info(&self) -> TractResult<Vec<String>> {
        Ok(self.pool_spec.info())
    }

    fn validation(&self) -> Validation {
        Validation::Rounding
    }

    op_as_typed_op!();
}

impl EvalOp for ChannelDepthWise {
    fn is_stateless(&self) -> bool {
        true
    }

    fn eval(&self, inputs: TVec<TValue>) -> TractResult<TVec<TValue>> {
        let (input, kernel, bias) = args_3!(inputs);
        ensure!(input.datum_type() == f32::datum_type());
        ensure!(kernel.datum_type() == f32::datum_type());
        ensure!(bias.datum_type() == f32::datum_type());

        let [batch, input_height, input_width, channels]: [usize; 4] = input
            .shape()
            .try_into()
            .map_err(|_| format_err!("channel depthwise input must be NHWC"))?;
        ensure!(channels == self.pool_spec.input_channels);
        ensure!(channels == self.pool_spec.output_channels);
        let [kernel_multiplier, kernel_height, kernel_width, kernel_channels]: [usize; 4] = kernel
            .shape()
            .try_into()
            .map_err(|_| format_err!("channel depthwise kernel must be OHWI"))?;
        ensure!(kernel_multiplier == 1);
        ensure!(kernel_channels == channels);
        ensure!(self.pool_spec.kernel_shape.as_slice() == [kernel_height, kernel_width]);
        ensure!(bias.len() == 1 || bias.len() == channels);

        let padding = self
            .pool_spec
            .computed_padding(&[input_height, input_width]);
        let output_height = padding[0].convoluted;
        let output_width = padding[1].convoluted;
        let output_shape = [batch, output_height, output_width, channels];
        let mut output = Tensor::zero::<f32>(&output_shape)?;

        let input = input.try_as_plain()?.as_slice::<f32>()?;
        let kernel = kernel.try_as_plain()?.as_slice::<f32>()?;
        let bias = bias.try_as_plain()?.as_slice::<f32>()?;
        let output_values = unsafe { output.as_slice_mut_unchecked::<f32>() };
        let stride_y = self.pool_spec.stride(0);
        let stride_x = self.pool_spec.stride(1);
        let dilation_y = self.pool_spec.dilation(0);
        let dilation_x = self.pool_spec.dilation(1);
        let pad_y = padding[0].pad_before;
        let pad_x = padding[1].pad_before;

        for batch_index in 0..batch {
            for output_y in 0..output_height {
                for output_x in 0..output_width {
                    let output_offset = ((batch_index * output_height + output_y) * output_width
                        + output_x)
                        * channels;
                    let output_channels =
                        &mut output_values[output_offset..output_offset + channels];
                    if bias.len() == 1 {
                        output_channels.fill(bias[0]);
                    } else {
                        output_channels.copy_from_slice(bias);
                    }

                    for kernel_y in 0..kernel_height {
                        let padded_y = output_y * stride_y + kernel_y * dilation_y;
                        if padded_y < pad_y {
                            continue;
                        }
                        let input_y = padded_y - pad_y;
                        if input_y >= input_height {
                            continue;
                        }
                        for kernel_x in 0..kernel_width {
                            let padded_x = output_x * stride_x + kernel_x * dilation_x;
                            if padded_x < pad_x {
                                continue;
                            }
                            let input_x = padded_x - pad_x;
                            if input_x >= input_width {
                                continue;
                            }
                            let input_offset =
                                ((batch_index * input_height + input_y) * input_width + input_x)
                                    * channels;
                            let kernel_offset = (kernel_y * kernel_width + kernel_x) * channels;
                            accumulate_channels(
                                output_channels,
                                &input[input_offset..input_offset + channels],
                                &kernel[kernel_offset..kernel_offset + channels],
                            );
                        }
                    }
                }
            }
        }
        Ok(tvec!(output.into_tvalue()))
    }
}

impl TypedOp for ChannelDepthWise {
    fn output_facts(&self, inputs: &[&TypedFact]) -> TractResult<TVec<TypedFact>> {
        ensure!(inputs.len() == 3);
        ensure!(inputs
            .iter()
            .all(|fact| fact.datum_type == f32::datum_type()));
        ensure!(inputs[0].rank() == 4);
        ensure!(inputs[1].rank() == 4);
        ensure!(inputs[2].rank() <= 1);
        self.pool_spec.output_facts(inputs)
    }

    fn cost(&self, inputs: &[&TypedFact]) -> TractResult<TVec<(Cost, TDim)>> {
        let output = self.pool_spec.output_shape(&inputs[0].shape)?;
        Ok(tvec!((
            Cost::FMA(f32::datum_type()),
            output.shape.iter().cloned().product::<TDim>()
                * self.pool_spec.kernel_shape.iter().product::<usize>()
        )))
    }

    as_op!();
}

pub(super) fn replace_depthwise_convolutions(model: &mut TypedModel) -> TractResult<usize> {
    let mut replacements = Vec::new();
    for node in model.nodes() {
        if let Some(convolution) = node.op_as::<Conv>() {
            let eligible = convolution.q_params.is_none()
                && convolution.kernel_fmt == KernelFormat::OHWI
                && convolution.pool_spec.data_format == DataFormat::NHWC
                && convolution.pool_spec.rank() == 2
                && convolution.group == convolution.pool_spec.input_channels
                && convolution.group == convolution.pool_spec.output_channels;
            if !eligible {
                continue;
            }
            let inputs = model.node_input_facts(node.id)?;
            let channels = convolution.group;
            let expected_kernel_shape = [
                1,
                convolution.pool_spec.kernel_shape[0],
                convolution.pool_spec.kernel_shape[1],
                channels,
            ];
            let facts_are_eligible = inputs.len() == 3
                && inputs
                    .iter()
                    .all(|fact| fact.datum_type == f32::datum_type())
                && inputs[0].rank() == 4
                && inputs[0].shape[3] == channels.to_dim()
                && inputs[1]
                    .shape
                    .as_concrete()
                    .is_some_and(|shape| shape == expected_kernel_shape)
                && (inputs[2].rank() == 0
                    || (inputs[2].rank() == 1 && inputs[2].shape.volume() == channels.to_dim()));
            if facts_are_eligible {
                replacements.push((node.id, convolution.pool_spec.clone()));
            }
        }
    }
    for (node_id, pool_spec) in &replacements {
        model.node_mut(*node_id).op = Box::new(ChannelDepthWise {
            pool_spec: pool_spec.clone(),
        });
    }
    Ok(replacements.len())
}

#[cfg(target_arch = "x86_64")]
#[inline(always)]
fn accumulate_channels(output: &mut [f32], input: &[f32], kernel: &[f32]) {
    use std::arch::x86_64::{_mm_add_ps, _mm_loadu_ps, _mm_mul_ps, _mm_storeu_ps};

    let vectorized = output.len() / 4 * 4;
    let mut channel = 0;
    while channel < vectorized {
        unsafe {
            let accumulated = _mm_loadu_ps(output.as_ptr().add(channel));
            let values = _mm_loadu_ps(input.as_ptr().add(channel));
            let weights = _mm_loadu_ps(kernel.as_ptr().add(channel));
            _mm_storeu_ps(
                output.as_mut_ptr().add(channel),
                _mm_add_ps(accumulated, _mm_mul_ps(values, weights)),
            );
        }
        channel += 4;
    }
    accumulate_scalar(
        &mut output[vectorized..],
        &input[vectorized..],
        &kernel[vectorized..],
    );
}

#[cfg(target_arch = "aarch64")]
#[inline(always)]
fn accumulate_channels(output: &mut [f32], input: &[f32], kernel: &[f32]) {
    use std::arch::aarch64::{vaddq_f32, vld1q_f32, vmulq_f32, vst1q_f32};

    let vectorized = output.len() / 4 * 4;
    let mut channel = 0;
    while channel < vectorized {
        unsafe {
            let accumulated = vld1q_f32(output.as_ptr().add(channel));
            let values = vld1q_f32(input.as_ptr().add(channel));
            let weights = vld1q_f32(kernel.as_ptr().add(channel));
            vst1q_f32(
                output.as_mut_ptr().add(channel),
                vaddq_f32(accumulated, vmulq_f32(values, weights)),
            );
        }
        channel += 4;
    }
    accumulate_scalar(
        &mut output[vectorized..],
        &input[vectorized..],
        &kernel[vectorized..],
    );
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
#[inline(always)]
fn accumulate_channels(output: &mut [f32], input: &[f32], kernel: &[f32]) {
    accumulate_scalar(output, input, kernel);
}

#[inline(always)]
fn accumulate_scalar(output: &mut [f32], input: &[f32], kernel: &[f32]) {
    for ((output, input), kernel) in output.iter_mut().zip(input).zip(kernel) {
        *output += input * kernel;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tract_tflite::internal::tract_core::ops::cnn::PaddingSpec;

    #[test]
    fn channel_depthwise_preserves_padding_stride_and_bias() {
        let operation = ChannelDepthWise {
            pool_spec: PoolSpec {
                data_format: DataFormat::NHWC,
                kernel_shape: tvec!(2, 2),
                padding: PaddingSpec::SameUpper,
                strides: Some(tvec!(2, 2)),
                dilations: None,
                input_channels: 2,
                output_channels: 2,
            },
        };
        let input = Tensor::from_shape(
            &[1, 3, 3, 2],
            &[
                1.0_f32, 10.0, 2.0, 20.0, 3.0, 30.0, 4.0, 40.0, 5.0, 50.0, 6.0, 60.0, 7.0, 70.0,
                8.0, 80.0, 9.0, 90.0,
            ],
        )
        .expect("input");
        let kernel =
            Tensor::from_shape(&[1, 2, 2, 2], &[1.0_f32, 0.1, 2.0, 0.2, 3.0, 0.3, 4.0, 0.4])
                .expect("kernel");
        let bias = Tensor::from_shape(&[2], &[0.5_f32, 1.0]).expect("bias");
        let output = operation
            .eval(tvec!(
                input.into_tvalue(),
                kernel.into_tvalue(),
                bias.into_tvalue()
            ))
            .expect("depthwise output");
        let values = output[0]
            .to_plain_array_view::<f32>()
            .expect("plain output")
            .iter()
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(output[0].shape(), &[1, 2, 2, 2]);
        assert_eq!(values, vec![37.5, 38.0, 21.5, 22.0, 23.5, 24.0, 9.5, 10.0]);
    }

    #[test]
    fn channel_depthwise_matches_tract_for_nontrivial_geometry() {
        for (input_shape, kernel_shape, padding, strides, dilations) in [
            ([1, 5, 7, 5], [3, 3], PaddingSpec::SameUpper, [1, 2], [1, 1]),
            (
                [2, 6, 5, 5],
                [2, 3],
                PaddingSpec::Explicit(tvec!(1, 2), tvec!(0, 1)),
                [2, 1],
                [2, 1],
            ),
        ] {
            let pool_spec = PoolSpec {
                data_format: DataFormat::NHWC,
                kernel_shape: tvec!(kernel_shape[0], kernel_shape[1]),
                padding,
                strides: Some(tvec!(strides[0], strides[1])),
                dilations: Some(tvec!(dilations[0], dilations[1])),
                input_channels: input_shape[3],
                output_channels: input_shape[3],
            };
            let input_values = deterministic_values(input_shape.iter().product(), 17, 31);
            let kernel_values = deterministic_values(
                kernel_shape.iter().product::<usize>() * input_shape[3],
                11,
                23,
            );
            let bias_values = deterministic_values(input_shape[3], 7, 13);
            let input = Tensor::from_shape(&input_shape, &input_values).expect("input");
            let kernel = Tensor::from_shape(
                &[1, kernel_shape[0], kernel_shape[1], input_shape[3]],
                &kernel_values,
            )
            .expect("kernel");
            let bias = Tensor::from_shape(&[input_shape[3]], &bias_values).expect("bias");
            let tract = Conv {
                pool_spec: pool_spec.clone(),
                kernel_fmt: KernelFormat::OHWI,
                group: input_shape[3],
                q_params: None,
            }
            .eval(tvec!(
                input.clone().into_tvalue(),
                kernel.clone().into_tvalue(),
                bias.clone().into_tvalue()
            ))
            .expect("tract output");
            let channel = ChannelDepthWise { pool_spec }
                .eval(tvec!(
                    input.into_tvalue(),
                    kernel.into_tvalue(),
                    bias.into_tvalue()
                ))
                .expect("channel output");
            assert_eq!(channel[0].shape(), tract[0].shape());
            let tract = tract[0]
                .to_plain_array_view::<f32>()
                .expect("plain tract output");
            let channel = channel[0]
                .to_plain_array_view::<f32>()
                .expect("plain channel output");
            for (actual, expected) in channel.iter().zip(tract.iter()) {
                let tolerance = 1e-5_f32.max(expected.abs() * 1e-5);
                assert!(
                    (actual - expected).abs() <= tolerance,
                    "channel result {actual} differs from tract result {expected}"
                );
            }
        }
    }

    fn deterministic_values(length: usize, multiplier: usize, modulus: usize) -> Vec<f32> {
        (0..length)
            .map(|index| ((index * multiplier) % modulus) as f32 / modulus as f32 - 0.5)
            .collect()
    }
}

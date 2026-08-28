use std::borrow::Cow;

pub(crate) const ASSISTANT_AGSL: &str = include_str!("../../../../visuals/shaders/assistant.agsl");

const GLSL_HEADER: &str = r#"#version 450

layout(location = 0) out vec4 fragmentColor;

layout(set = 0, binding = 0, std140) uniform VisualUniforms {
    vec4 resolutionTimeEnergy;
    vec4 accent;
    vec4 shape;
    vec4 behavior;
    vec4 shipViewMaterializationPropulsion;
} visual;

#define iResolution visual.resolutionTimeEnergy.xy
#define iTime visual.resolutionTimeEnergy.z
#define iEnergy visual.resolutionTimeEnergy.w
#define iAccent visual.accent
#define iShape visual.shape
#define iBehavior visual.behavior
#define iShipView visual.shipViewMaterializationPropulsion.xy
#define iShipMaterialization visual.shipViewMaterializationPropulsion.z
#define iShipPropulsion visual.shipViewMaterializationPropulsion.w

"#;

pub(crate) fn assistant_glsl() -> Cow<'static, str> {
    let body = ASSISTANT_AGSL
        .lines()
        .filter(|line| !line.starts_with("uniform "))
        .collect::<Vec<_>>()
        .join("\n")
        .replace("half4", "vec4")
        .replace("float4", "vec4")
        .replace("float3", "vec3")
        .replace("float2", "vec2")
        .replace(
            "vec4 main(vec2 fragCoord) {",
            "void main() {\n    vec2 fragCoord = gl_FragCoord.xy;",
        )
        .replace(
            "return vec4(color, alpha);",
            "fragmentColor = vec4(color, alpha);",
        );
    Cow::Owned(format!("{GLSL_HEADER}{body}\n"))
}

#[cfg(test)]
mod tests {
    use naga::front::glsl::{Frontend, Options};
    use naga::ShaderStage;

    #[test]
    fn canonical_assistant_shader_compiles_as_glsl() {
        let mut frontend = Frontend::default();
        frontend
            .parse(
                &Options {
                    stage: ShaderStage::Fragment,
                    defines: Default::default(),
                },
                &super::assistant_glsl(),
            )
            .expect("shared assistant shader should compile for the desktop renderer");
    }
}

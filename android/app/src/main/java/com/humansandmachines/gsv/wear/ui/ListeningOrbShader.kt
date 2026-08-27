package com.humansandmachines.gsv.wear.ui

internal const val LISTENING_ORB_SHADER = """
uniform float2 iResolution;
uniform float iTime;
uniform float iEnergy;
uniform float4 iAccent;

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

float2 rotate2(float angle, float2 point) {
    float sine = sin(angle);
    float cosine = cos(angle);
    return float2(cosine * point.x - sine * point.y, sine * point.x + cosine * point.y);
}

float smoothMinimum(float first, float second, float radius) {
    float blend = clamp(0.5 + 0.5 * (second - first) / radius, 0.0, 1.0);
    return mix(second, first, blend) - radius * blend * (1.0 - blend);
}

float smoothMaximum(float first, float second, float radius) {
    return -smoothMinimum(-first, -second, radius);
}

float ellipsoidDistance(float3 point, float3 radii) {
    float normalized = length(point / radii);
    float gradient = length(point / (radii * radii));
    return normalized * (normalized - 1.0) / max(gradient, 0.0001);
}

float organicDistance(float3 point, float phase, float energy) {
    point.xz = rotate2(phase, point.xz);
    point.xy = rotate2(0.24 * sin(phase * 2.0), point.xy);
    point.yz = rotate2(0.19 * cos(phase * 3.0), point.yz);

    float3 folded = point;
    folded.xz = rotate2(0.62 * sin(folded.y * 4.4 + phase), folded.xz);
    folded.xy = rotate2(0.40 * sin(folded.z * 5.2 - phase * 2.0), folded.xy);

    float breath = 1.0 + 0.025 * sin(phase * 2.0) + energy * 0.025;
    float response = 0.82 + energy * 0.35;
    float distance = ellipsoidDistance(
        folded,
        float3(0.24, 0.29, 0.23) * breath
    );

    float3 firstCenter = float3(
        0.14 * cos(phase),
        0.10 * sin(phase * 2.0),
        0.11 * sin(phase)
    ) * response;
    float3 secondCenter = float3(
        -0.13 * sin(phase),
        0.12 * cos(phase * 2.0),
        -0.11 * cos(phase)
    ) * response;
    float3 thirdCenter = float3(
        0.09 * sin(phase * 3.0),
        -0.15 * cos(phase),
        0.12 * cos(phase * 2.0)
    ) * response;

    float3 firstPoint = folded - firstCenter;
    firstPoint.xy = rotate2(0.52 + 0.72 * sin(phase), firstPoint.xy);
    firstPoint.yz = rotate2(0.36 * cos(phase * 2.0), firstPoint.yz);
    float3 secondPoint = folded - secondCenter;
    secondPoint.xz = rotate2(-0.64 + 0.58 * cos(phase), secondPoint.xz);
    secondPoint.xy = rotate2(0.44 * sin(phase * 2.0), secondPoint.xy);
    float3 thirdPoint = folded - thirdCenter;
    thirdPoint.yz = rotate2(0.73 + 0.48 * sin(phase * 3.0), thirdPoint.yz);
    thirdPoint.xz = rotate2(-0.37 * cos(phase * 2.0), thirdPoint.xz);

    float firstLobe = ellipsoidDistance(
        firstPoint,
        float3(0.33, 0.14, 0.22) * breath
    );
    float secondLobe = ellipsoidDistance(
        secondPoint,
        float3(0.16, 0.33, 0.23) * breath
    );
    float thirdLobe = ellipsoidDistance(
        thirdPoint,
        float3(0.25, 0.15, 0.31) * breath
    );

    distance = smoothMinimum(distance, firstLobe, 0.085);
    distance = smoothMinimum(distance, secondLobe, 0.090);
    distance = smoothMinimum(distance, thirdLobe, 0.082);

    float3 firstCavityCenter = float3(
        0.28 * cos(phase * 2.0),
        0.21 * sin(phase),
        0.25 * cos(phase)
    );
    float3 secondCavityCenter = float3(
        -0.24 * sin(phase),
        -0.27 * cos(phase * 2.0),
        -0.22 * sin(phase * 2.0)
    );
    float firstCavity = ellipsoidDistance(
        folded - firstCavityCenter,
        float3(0.21, 0.17, 0.20)
    );
    float secondCavity = ellipsoidDistance(
        folded - secondCavityCenter,
        float3(0.17, 0.22, 0.18)
    );
    distance = smoothMaximum(distance, -firstCavity, 0.055);
    distance = smoothMaximum(distance, -secondCavity, 0.050);

    float surfaceFold = sin(folded.x * 10.0 + sin(phase) * 2.0) *
        sin(folded.y * 9.0 - cos(phase * 2.0) * 1.6) *
        sin(folded.z * 11.0 + sin(phase * 3.0) * 1.4);
    distance += surfaceFold * (0.010 + energy * 0.015);
    return distance;
}

float2 sphereRange(float3 origin, float3 direction, float radius) {
    float projected = dot(origin, direction);
    float discriminant = projected * projected - dot(origin, origin) + radius * radius;
    if (discriminant < 0.0) {
        return float2(-1.0, -1.0);
    }
    float root = sqrt(discriminant);
    return float2(-projected - root, -projected + root);
}

float marchOrganic(
    float3 origin,
    float3 direction,
    float start,
    float end,
    float phase,
    float energy
) {
    float travel = start;
    for (int index = 0; index < 36; ++index) {
        float distance = organicDistance(origin + direction * travel, phase, energy);
        if (distance < 0.0018) {
            return travel;
        }
        travel += max(distance * 0.66, 0.0045);
        if (travel > end) {
            break;
        }
    }
    return end + 1.0;
}

float3 organicNormal(float3 point, float phase, float energy) {
    const float offset = 0.004;
    float3 xStep = float3(offset, 0.0, 0.0);
    float3 yStep = float3(0.0, offset, 0.0);
    float3 zStep = float3(0.0, 0.0, offset);
    return normalize(float3(
        organicDistance(point + xStep, phase, energy) - organicDistance(point - xStep, phase, energy),
        organicDistance(point + yStep, phase, energy) - organicDistance(point - yStep, phase, energy),
        organicDistance(point + zStep, phase, energy) - organicDistance(point - zStep, phase, energy)
    ));
}

float shellCurrent(float3 normal, float phase) {
    float3 first = normal;
    first.xy = rotate2(0.68, first.xy);
    first.xz = rotate2(phase, first.xz);
    float firstPath = 1.0 - smoothstep(
        0.014,
        0.042,
        abs(first.y + 0.075 * sin(first.x * 5.0 + phase * 2.0))
    );

    float3 second = normal;
    second.yz = rotate2(-0.82, second.yz);
    second.xy = rotate2(-phase * 2.0, second.xy);
    float secondPath = 1.0 - smoothstep(
        0.010,
        0.034,
        abs(second.z + 0.055 * sin(second.y * 6.0 - phase * 3.0))
    );
    return max(firstPath * 0.74, secondPath * 0.46);
}

float spatialGrain(float2 coordinate) {
    float2 cell = fract(coordinate * float2(0.06711056, 0.00583715));
    cell += dot(cell, cell.yx + 19.19);
    return fract(cell.x * cell.y * 95.4337);
}

half4 main(float2 fragCoord) {
    float shortest = min(iResolution.x, iResolution.y);
    float2 uv = (fragCoord - iResolution * 0.5) / shortest;
    uv.y = -uv.y;

    float energy = clamp(iEnergy, 0.0, 1.0);
    float phase = TAU * iTime / 12.0;
    float3 origin = float3(0.0, 0.0, 2.35);
    float3 direction = normalize(float3(uv * 1.82, -2.15));
    float2 shell = sphereRange(origin, direction, 0.69);

    float screenRadius = length(uv);
    float aura = exp(-abs(screenRadius - 0.355) * 24.0) * (0.025 + energy * 0.018);
    if (shell.x < 0.0) {
        float alpha = clamp(aura, 0.0, 0.08);
        return half4(iAccent.rgb * alpha, alpha);
    }

    float3 shellPoint = origin + direction * shell.x;
    float3 shellNormal = normalize(shellPoint);
    float shellFacing = clamp(dot(shellNormal, -direction), 0.0, 1.0);
    float shellFresnel = pow(1.0 - shellFacing, 3.0);
    float current = shellCurrent(shellNormal, phase);
    float shellPulse = 0.86 + 0.14 * sin(phase * 3.0);

    float travel = marchOrganic(origin, direction, shell.x, shell.y, phase, energy);
    bool bodyHit = travel <= shell.y;

    float3 color = iAccent.rgb * aura;
    float alpha = aura;

    if (bodyHit) {
        float3 point = origin + direction * travel;
        float3 normal = organicNormal(point, phase, energy);
        float3 view = -direction;

        float3 cyanLight = normalize(float3(-0.55, 0.72, 0.84));
        float3 warmLight = normalize(float3(0.72, -0.20, 0.54));
        float coolDiffuse = max(dot(normal, cyanLight), 0.0);
        float warmDiffuse = max(dot(normal, warmLight), 0.0);
        float fresnel = pow(1.0 - clamp(dot(normal, view), 0.0, 1.0), 2.7);
        float coolSpecular = pow(
            max(dot(normal, normalize(cyanLight + view)), 0.0),
            42.0 - energy * 12.0
        );
        float warmSpecular = pow(
            max(dot(normal, normalize(warmLight + view)), 0.0),
            58.0
        );
        float silhouette = pow(1.0 - abs(dot(normal, view)), 1.7);

        float3 deepMaterial = float3(0.004, 0.010, 0.027);
        float3 cyan = mix(float3(0.05, 0.70, 0.90), iAccent.rgb, 0.48);
        float3 warm = float3(1.0, 0.62, 0.22);
        float3 material = deepMaterial;
        material += cyan * (coolDiffuse * 0.22 + fresnel * 0.62 + coolSpecular * 1.15);
        material += warm * (warmDiffuse * 0.075 + warmSpecular * 0.62);
        material += float3(0.26, 0.46, 0.72) * silhouette * 0.16;

        float bodyAlpha = clamp(0.88 + fresnel * 0.10 + coolSpecular * 0.06, 0.0, 0.98);
        color = material * bodyAlpha;
        alpha = bodyAlpha;
    }

    float shellLight = shellFresnel * (0.30 + energy * 0.20) + current * shellPulse * 0.13;
    float warmEdge = pow(max(shellNormal.x, 0.0), 3.0) * shellFresnel * 0.22;
    color += iAccent.rgb * shellLight;
    color += float3(1.0, 0.64, 0.24) * warmEdge;
    alpha = clamp(alpha + shellLight * 0.48 + warmEdge * 0.34, 0.0, 0.99);

    float grain = (spatialGrain(fragCoord) - 0.5) * 0.012;
    color += grain * alpha;
    color = max(color, float3(0.0, 0.0, 0.0));
    return half4(color, alpha);
}
"""

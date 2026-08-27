package com.humansandmachines.gsv.wear.ui

internal const val LISTENING_ORB_SHADER = """
uniform float2 iResolution;
uniform float iTime;
uniform float iEnergy;
uniform float4 iAccent;
uniform float4 iShape;

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

float3 symbolFlowPoint(float3 point, float phase, float presence) {
    float3 flowingPoint = point;
    flowingPoint.xz = rotate2(
        0.055 * sin(flowingPoint.y * 6.0 + phase),
        flowingPoint.xz
    );
    flowingPoint.xy = rotate2(
        0.038 * sin(flowingPoint.z * 7.0 - phase * 2.0),
        flowingPoint.xy
    );
    flowingPoint += float3(
        0.0045 * sin(point.y * 9.0 + phase * 3.0),
        0.0040 * sin(point.z * 8.0 - phase),
        0.0030 * sin(point.x * 10.0 + phase * 2.0)
    );
    return mix(point, flowingPoint, presence);
}

float facialFeatureDistance(float3 point, float phase) {
    float eyeSpacing = clamp(iShape.z, 0.08, 0.18);
    float smileCurve = clamp(iShape.w, 0.0, 1.4);
    float3 leftEyeCenter = float3(
        -eyeSpacing * 0.96 + 0.004 * sin(phase * 2.0),
        0.088 + 0.005 * sin(phase * 3.0),
        0.335 + 0.003 * cos(phase)
    );
    float3 rightEyeCenter = float3(
        eyeSpacing * 1.04 + 0.005 * cos(phase * 3.0),
        0.076 + 0.004 * cos(phase * 2.0),
        0.338 + 0.003 * sin(phase * 2.0)
    );
    float leftEye = ellipsoidDistance(
        point - leftEyeCenter,
        float3(
            0.043 + 0.002 * sin(phase),
            0.064 + 0.003 * cos(phase * 2.0),
            0.091
        )
    );
    float rightEye = ellipsoidDistance(
        point - rightEyeCenter,
        float3(
            0.048 + 0.002 * cos(phase * 2.0),
            0.058 + 0.003 * sin(phase * 3.0),
            0.088
        )
    );
    float eyes = min(leftEye, rightEye);

    float leftMouthWidth = 0.142 + 0.004 * sin(phase * 2.0);
    float rightMouthWidth = 0.150 + 0.003 * cos(phase * 3.0);
    float mouthX = clamp(point.x, -leftMouthWidth, rightMouthWidth);
    float mouthSideWidth = mix(leftMouthWidth, rightMouthWidth, step(0.0, mouthX));
    float normalizedMouthX = mouthX / mouthSideWidth;
    float mouthY = -0.133 + 0.003 * sin(phase) +
        0.058 * smileCurve * normalizedMouthX * normalizedMouthX +
        0.006 * normalizedMouthX +
        0.005 * sin(phase * 2.0 + normalizedMouthX * 2.6);
    float mouthZ = 0.340 +
        0.003 * cos(phase * 3.0 - normalizedMouthX * 2.0);
    float mouth = ellipsoidDistance(
        float3(point.x - mouthX, point.y - mouthY, point.z - mouthZ),
        float3(0.027, 0.024, 0.078)
    );
    return min(eyes, mouth);
}

float organicDistance(float3 point, float phase, float energy) {
    float organicAmount = clamp(iShape.x, 0.0, 1.0);
    float symbolPresence = clamp(iShape.y, 0.0, 1.0);
    float3 anchoredPoint = point;
    float3 animatedPoint = point;
    animatedPoint.xz = rotate2(phase, animatedPoint.xz);
    animatedPoint.xy = rotate2(0.24 * sin(phase * 2.0), animatedPoint.xy);
    animatedPoint.yz = rotate2(0.19 * cos(phase * 3.0), animatedPoint.yz);
    point = mix(anchoredPoint, animatedPoint, organicAmount);

    float3 foldedTarget = point;
    foldedTarget.xz = rotate2(0.62 * sin(foldedTarget.y * 4.4 + phase), foldedTarget.xz);
    foldedTarget.xy = rotate2(0.40 * sin(foldedTarget.z * 5.2 - phase * 2.0), foldedTarget.xy);
    float3 folded = mix(point, foldedTarget, organicAmount);

    float breath = 1.0 + 0.025 * sin(phase * 2.0) + energy * 0.025;
    float response = 0.82 + energy * 0.35;
    float liquidDistance = ellipsoidDistance(
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

    liquidDistance = smoothMinimum(liquidDistance, firstLobe, 0.085);
    liquidDistance = smoothMinimum(liquidDistance, secondLobe, 0.090);
    liquidDistance = smoothMinimum(liquidDistance, thirdLobe, 0.082);

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
    liquidDistance = smoothMaximum(liquidDistance, -firstCavity, 0.055);
    liquidDistance = smoothMaximum(liquidDistance, -secondCavity, 0.050);

    float surfaceFold = sin(folded.x * 10.0 + sin(phase) * 2.0) *
        sin(folded.y * 9.0 - cos(phase * 2.0) * 1.6) *
        sin(folded.z * 11.0 + sin(phase * 3.0) * 1.4);
    liquidDistance += surfaceFold * (0.010 + energy * 0.015) * organicAmount;

    float3 symbolPoint = symbolFlowPoint(anchoredPoint, phase, symbolPresence);
    float3 sphereRadii = float3(0.365, 0.375, 0.35) *
        (1.0 + energy * 0.012) *
        float3(
            1.0 + symbolPresence * 0.012 * sin(phase * 2.0),
            1.0 + symbolPresence * 0.010 * cos(phase * 3.0),
            1.0 + symbolPresence * 0.009 * sin(phase)
        );
    float sphereDistance = ellipsoidDistance(symbolPoint, sphereRadii);
    float symbolSurface = sin(symbolPoint.x * 9.0 + phase) *
        sin(symbolPoint.y * 8.0 - phase * 2.0) *
        sin(symbolPoint.z * 10.0 + phase * 3.0);
    sphereDistance += symbolSurface * symbolPresence * (0.0045 + energy * 0.0025);
    float distance = mix(sphereDistance, liquidDistance, organicAmount);
    if (symbolPresence > 0.001) {
        float featureCut = -facialFeatureDistance(symbolPoint, phase) -
            (1.0 - symbolPresence) * 0.30;
        distance = smoothMaximum(distance, featureCut, 0.026);
    }
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

float3 interiorFlowPoint(float3 point, float phase) {
    float3 flowingPoint = point;
    flowingPoint.xz = rotate2(
        0.58 + 0.22 * sin(phase),
        flowingPoint.xz
    );
    flowingPoint.xy = rotate2(
        -0.37 + 0.17 * cos(phase * 2.0),
        flowingPoint.xy
    );
    flowingPoint.yz = rotate2(
        0.19 * sin(phase * 3.0),
        flowingPoint.yz
    );
    flowingPoint += float3(
        0.026 * sin(flowingPoint.y * 7.0 + phase * 2.0) *
            cos(flowingPoint.z * 5.0 - phase),
        0.022 * sin(flowingPoint.z * 8.0 - phase * 2.0) *
            cos(flowingPoint.x * 6.0 + phase * 3.0),
        0.020 * sin(flowingPoint.x * 9.0 + phase) *
            cos(flowingPoint.y * 5.0 - phase * 3.0)
    );
    return flowingPoint;
}

float4 interiorMembranes(float3 point, float phase) {
    float3 flowingPoint = interiorFlowPoint(point, phase);
    float coolSurface = flowingPoint.y +
        0.105 * sin(flowingPoint.x * 7.0 + phase) +
        0.052 * sin(flowingPoint.z * 9.0 - phase * 2.0);
    float warmSurface = flowingPoint.x * 0.72 - flowingPoint.z * 0.28 +
        0.082 * sin(flowingPoint.y * 8.0 - phase * 2.0) +
        0.038 * cos(flowingPoint.x * 10.0 + phase * 3.0);

    float coolVariation = 0.58 + 0.42 *
        (0.5 + 0.5 * sin((flowingPoint.x - flowingPoint.z) * 8.0 + phase * 3.0));
    float warmVariation = 0.54 + 0.46 *
        (0.5 + 0.5 * cos((flowingPoint.y + flowingPoint.z) * 9.0 - phase));
    float coolSheet = (1.0 - smoothstep(0.016, 0.088, abs(coolSurface))) * coolVariation;
    float coolRidge = (1.0 - smoothstep(0.005, 0.022, abs(coolSurface))) * coolVariation;
    float warmSheet = (1.0 - smoothstep(0.014, 0.076, abs(warmSurface))) * warmVariation;
    float warmRidge = (1.0 - smoothstep(0.004, 0.019, abs(warmSurface))) * warmVariation;
    return float4(coolSheet, coolRidge, warmSheet, warmRidge);
}

float3 refractIntoLiquid(float3 incident, float3 normal, float energy) {
    float eta = 0.84 - energy * 0.025;
    float incidentCosine = dot(normal, incident);
    float discriminant = 1.0 - eta * eta *
        (1.0 - incidentCosine * incidentCosine);
    return normalize(
        eta * incident -
            (eta * incidentCosine + sqrt(max(discriminant, 0.0))) * normal
    );
}

float interiorDensity(float3 point, float phase, float energy) {
    float distance = organicDistance(point, phase, energy);
    return 1.0 - smoothstep(-0.002, 0.015, distance);
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
    float containmentRadius = 0.355 +
        0.004 * energy * sin(phase * 2.0);
    float aura = exp(-abs(screenRadius - containmentRadius) * 24.0) *
        (0.020 + energy * 0.015);
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
        float facing = clamp(dot(normal, view), 0.0, 1.0);
        float3 interiorDirection = refractIntoLiquid(direction, normal, energy);
        float3 nearPoint = point + interiorDirection * 0.035;
        float3 middlePoint = point + interiorDirection * 0.140;
        float3 deepPoint = point + interiorDirection * 0.240;
        float middleDensity = interiorDensity(middlePoint, phase, energy);
        float deepDensity = middleDensity * (0.35 + facing * 0.65);
        float estimatedThickness = 0.065 + facing * 0.060 +
            middleDensity * 0.340;
        float3 transmittance = exp(
            -estimatedThickness * float3(8.6, 4.1, 2.0)
        );
        float thicknessFactor = 1.0 - exp(-estimatedThickness * 5.2);
        float4 nearMembranes = interiorMembranes(nearPoint, phase);
        float4 middleMembranes = interiorMembranes(middlePoint, phase) * middleDensity;
        float4 deepMembranes = interiorMembranes(deepPoint, phase) * deepDensity;
        float coolSheet = clamp(
            nearMembranes.x * 0.25 +
                middleMembranes.x * 0.65 +
                deepMembranes.x * 0.28,
            0.0,
            1.0
        );
        float coolRidge = max(
            nearMembranes.y * 0.25,
            middleMembranes.y
        );
        float warmSheet = clamp(
            nearMembranes.z * 0.28 +
                middleMembranes.z * 0.60 +
                deepMembranes.z * 0.30,
            0.0,
            1.0
        );
        float warmRidge = nearMembranes.w * 0.72 + deepMembranes.w * 0.16;
        float organicAmount = clamp(iShape.x, 0.0, 1.0);
        float liquidDetail = 0.28 + organicAmount * 0.72;
        float membraneCrossing = coolRidge * warmRidge;
        float thinTransmission = transmittance.g *
            (0.32 + 0.68 * pow(1.0 - facing, 1.35));
        float warmTransmission = transmittance.g *
            pow(max(dot(-normal, warmLight), 0.0), 1.7);
        float interiorVisibility = 0.50 + transmittance.b * 0.65;

        float3 deepMaterial = float3(0.002, 0.007, 0.021);
        float3 cyan = mix(float3(0.05, 0.70, 0.90), iAccent.rgb, 0.48);
        float3 warm = float3(1.0, 0.62, 0.22);
        float3 material = deepMaterial +
            float3(0.004, 0.026, 0.060) * thicknessFactor;
        material += cyan * (coolDiffuse * 0.13 + fresnel * 0.54 + coolSpecular * 0.96);
        material += warm * (warmDiffuse * 0.052 + warmSpecular * 0.52);
        material += float3(0.26, 0.46, 0.72) * silhouette * 0.12;
        material += cyan * liquidDetail * interiorVisibility *
            (coolSheet * 0.13 + coolRidge * 0.23);
        material += warm * liquidDetail * interiorVisibility *
            (warmSheet * 0.065 + warmRidge * 0.15);
        material += mix(cyan, warm, 0.20) * liquidDetail *
            interiorVisibility * membraneCrossing * 0.12;
        material += cyan * liquidDetail * thinTransmission * 0.12;
        material += mix(cyan, warm, 0.58) * liquidDetail * warmTransmission * 0.10;
        material *= 1.0 - liquidDetail * min(coolSheet + warmSheet, 1.0) * 0.030;
        float symbolPresence = clamp(iShape.y, 0.0, 1.0);
        if (symbolPresence > 0.001) {
            float3 symbolPoint = symbolFlowPoint(point, phase, symbolPresence);
            float featureGlow = 1.0 - smoothstep(
                0.006,
                0.050,
                abs(facialFeatureDistance(symbolPoint, phase))
            );
            material += mix(cyan, warm, 0.24) * featureGlow * symbolPresence * 0.17;
        }

        float membraneOpacity = min(coolSheet + warmSheet, 1.0) * liquidDetail * 0.055;
        float absorptionAlpha = 1.0 - dot(
            transmittance,
            float3(0.18, 0.55, 0.27)
        );
        float bodyAlpha = clamp(
            0.38 + absorptionAlpha * 0.47 +
                fresnel * 0.12 + coolSpecular * 0.050 + membraneOpacity,
            0.0,
            0.94
        );
        color = material * bodyAlpha;
        alpha = bodyAlpha;
    }

    float shellVisibility = bodyHit ? 0.54 : 1.0;
    float shellLight = (
        shellFresnel * (0.21 + energy * 0.15) +
            current * shellPulse * (0.075 + energy * 0.035)
    ) * shellVisibility;
    float warmEdge = pow(max(shellNormal.x, 0.0), 3.0) *
        shellFresnel * 0.15 * shellVisibility;
    color += iAccent.rgb * shellLight;
    color += float3(1.0, 0.64, 0.24) * warmEdge;
    alpha = clamp(alpha + shellLight * 0.38 + warmEdge * 0.26, 0.0, 0.98);

    float grain = (spatialGrain(fragCoord) - 0.5) * 0.012;
    color += grain * alpha;
    color = max(color, float3(0.0, 0.0, 0.0));
    return half4(color, alpha);
}
"""

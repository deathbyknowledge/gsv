package com.humansandmachines.gsv.wear.authority

import java.util.UUID

enum class AuthorityState {
    DISARMED,
    ARMED,
    PAUSED,
}

class AuthorityLease internal constructor(internal val generation: String) {
    override fun toString(): String = "AuthorityLease(<redacted>)"
}

class WearAuthority(
    private val generationFactory: () -> String = { UUID.randomUUID().toString() },
) {
    private var generation: String? = null
    private var currentState = AuthorityState.DISARMED

    @Synchronized
    fun arm(): AuthorityLease {
        val next = generationFactory()
        check(next.isNotBlank()) { "Authority generation cannot be blank" }
        generation = next
        currentState = AuthorityState.ARMED
        return AuthorityLease(next)
    }

    @Synchronized
    fun pause(): Boolean {
        if (currentState != AuthorityState.ARMED) return false
        currentState = AuthorityState.PAUSED
        return true
    }

    @Synchronized
    fun resume(): Boolean {
        if (currentState != AuthorityState.PAUSED || generation == null) return false
        currentState = AuthorityState.ARMED
        return true
    }

    @Synchronized
    fun disarm() {
        generation = null
        currentState = AuthorityState.DISARMED
    }

    @Synchronized
    fun acquire(): AuthorityLease? =
        generation?.takeIf { currentState == AuthorityState.ARMED }?.let(::AuthorityLease)

    @Synchronized
    fun isCurrent(lease: AuthorityLease): Boolean =
        currentState == AuthorityState.ARMED && generation == lease.generation

    @Synchronized
    fun state(): AuthorityState = currentState
}

package com.humansandmachines.gsv.wear.config

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class CredentialStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    @Synchronized
    fun saveToken(token: String) {
        saveSecret(DRIVER_TOKEN_SLOT, token)
    }

    @Synchronized
    fun saveVoiceToken(token: String) {
        saveSecret(VOICE_TOKEN_SLOT, token)
    }

    @Synchronized
    fun loadToken(): String? = loadSecret(DRIVER_TOKEN_SLOT)

    @Synchronized
    fun loadVoiceToken(): String? = loadSecret(VOICE_TOKEN_SLOT)

    fun hasToken(): Boolean = hasSecret(DRIVER_TOKEN_SLOT)

    fun hasVoiceToken(): Boolean = hasSecret(VOICE_TOKEN_SLOT)

    private fun saveSecret(slot: SecretSlot, value: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val saved = preferences.edit()
            .putString(slot.ivKey, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString(slot.ciphertextKey, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .commit()
        check(saved) { "Could not persist the credential" }
    }

    private fun loadSecret(slot: SecretSlot): String? {
        val encodedIv = preferences.getString(slot.ivKey, null) ?: return null
        val encodedCiphertext = preferences.getString(slot.ciphertextKey, null) ?: return null
        val cipher = Cipher.getInstance(TRANSFORMATION)
        val iv = Base64.decode(encodedIv, Base64.NO_WRAP)
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        val plaintext = cipher.doFinal(Base64.decode(encodedCiphertext, Base64.NO_WRAP))
        return plaintext.toString(Charsets.UTF_8)
    }

    private fun hasSecret(slot: SecretSlot): Boolean =
        preferences.contains(slot.ivKey) && preferences.contains(slot.ciphertextKey)

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        private const val PREFERENCES = "gsv_wear_credentials"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "gsv_wear_driver_token"
        private val DRIVER_TOKEN_SLOT = SecretSlot("driver_token_iv", "driver_token_ciphertext")
        private val VOICE_TOKEN_SLOT = SecretSlot("voice_token_iv", "voice_token_ciphertext")
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }

    private data class SecretSlot(
        val ivKey: String,
        val ciphertextKey: String,
    )
}

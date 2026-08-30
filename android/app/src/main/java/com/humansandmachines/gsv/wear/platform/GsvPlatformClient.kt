package com.humansandmachines.gsv.wear.platform

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.util.Log
import com.humansandmachines.gsv.platform.IGsvPlatformService
import java.io.Closeable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class GsvPlatformClient(context: Context) : Closeable {
    private val applicationContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Any()

    @Volatile
    var status: GsvPlatformStatus? = null
        private set

    private var bindingRegistered = false
    private var closed = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            val service = IGsvPlatformService.Stub.asInterface(binder)
            scope.launch {
                try {
                    val apiVersion = service.apiVersion
                    if (!GsvPlatformContract.supportsApiVersion(apiVersion)) {
                        Log.e(TAG, "GSV platform API version $apiVersion is unsupported")
                        status = null
                        return@launch
                    }
                    val connected = GsvPlatformStatus(
                        apiVersion = apiVersion,
                        serviceVersion = service.serviceVersion,
                        startedElapsedRealtimeMillis = service.startedElapsedRealtimeMillis,
                    )
                    status = connected
                    Log.i(TAG, "connected api=${connected.apiVersion} service=${connected.serviceVersion}")
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    status = null
                    Log.w(TAG, "GSV platform handshake failed", error)
                }
            }
        }

        override fun onServiceDisconnected(name: ComponentName) {
            status = null
        }

        override fun onBindingDied(name: ComponentName) {
            status = null
        }

        override fun onNullBinding(name: ComponentName) {
            status = null
        }
    }

    fun connect() {
        synchronized(lock) {
            if (closed || bindingRegistered) return
            val intent = Intent(GsvPlatformContract.SERVICE_ACTION).setComponent(
                ComponentName(
                    GsvPlatformContract.PACKAGE_NAME,
                    GsvPlatformContract.SERVICE_CLASS_NAME,
                ),
            )
            bindingRegistered = try {
                applicationContext.bindService(intent, connection, Context.BIND_AUTO_CREATE)
            } catch (error: SecurityException) {
                Log.w(TAG, "GSV platform service rejected the client signature", error)
                false
            }
        }
    }

    override fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            status = null
            if (bindingRegistered) {
                applicationContext.unbindService(connection)
                bindingRegistered = false
            }
        }
        scope.cancel()
    }

    private companion object {
        const val TAG = "GsvPlatformClient"
    }
}

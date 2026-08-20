package com.humansandmachines.gsv.wear.connection

import com.humansandmachines.gsv.wear.protocol.IncomingRequest

interface DriverTransport {
    val epoch: Long

    fun sendText(text: String): Boolean

    fun sendBinary(bytes: ByteArray): Boolean
}

interface DriverRequestDispatcher {
    fun onRequest(request: IncomingRequest)

    fun onRequestCancel(id: String)

    fun onBinary(bytes: ByteArray)

    fun close()
}

fun interface DriverRequestDispatcherFactory {
    fun create(transport: DriverTransport): DriverRequestDispatcher
}

class UnsupportedRequestDispatcher(private val transport: DriverTransport) : DriverRequestDispatcher {
    override fun onRequest(request: IncomingRequest) {
        transport.sendText(
            com.humansandmachines.gsv.wear.protocol.GsvProtocol.errorResponse(
                request.id,
                501,
                "Android driver runtime is not armed",
            ),
        )
    }

    override fun onRequestCancel(id: String) = Unit

    override fun onBinary(bytes: ByteArray) = Unit

    override fun close() = Unit
}

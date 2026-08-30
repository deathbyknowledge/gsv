package com.humansandmachines.gsv.wear

import android.app.Application
import com.humansandmachines.gsv.wear.platform.GsvPlatformClient
import com.humansandmachines.gsv.wear.voice.AssistantRuntimeController

class GsvWearApplication : Application() {
    lateinit var assistantRuntime: AssistantRuntimeController
        private set
    lateinit var platformClient: GsvPlatformClient
        private set

    override fun onCreate() {
        super.onCreate()
        platformClient = GsvPlatformClient(applicationContext)
        platformClient.connect()
        assistantRuntime = AssistantRuntimeController(applicationContext)
    }

    override fun onTerminate() {
        assistantRuntime.close()
        platformClient.close()
        super.onTerminate()
    }
}

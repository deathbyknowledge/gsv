package com.humansandmachines.gsv.wear

import android.app.Application
import com.humansandmachines.gsv.wear.voice.AssistantRuntimeController

class GsvWearApplication : Application() {
    lateinit var assistantRuntime: AssistantRuntimeController
        private set

    override fun onCreate() {
        super.onCreate()
        assistantRuntime = AssistantRuntimeController(applicationContext)
    }

    override fun onTerminate() {
        assistantRuntime.close()
        super.onTerminate()
    }
}

#include "system.h"

#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "log/log.h"
#include "util/filesystem.h"

int system_exec(const char *command) {
    LOGI("System Execute: %s", command);
#ifdef EMULATOR_BUILD
    LOGD("Emulator skipped hardware command");
    return 0;
#else
    return system(command);
#endif
}

int system_script(const char *command) {
    LOGI("System Script: %s", command);
#ifdef EMULATOR_BUILD
    LOGD("Emulator skipped hardware script");
    return 0;
#else
    // basename may edit argument
    const char *script = fs_basename(command);

    // Modify command to log std out and error to a temporary file
    char buffer[256];
    snprintf(buffer,
             sizeof(buffer), "%s > /tmp/%s.log 2>&1",
             command,
             script);
    int retval = system(buffer);

    // Read contents of temporary file and use logging framework
    snprintf(buffer, sizeof(buffer), "/tmp/%s.log", script);
    FILE *fp = fopen(buffer, "r");
    if (fp) {
        char *line = NULL;
        size_t len = 0;
        ssize_t read = 0;
        while ((read = getline(&line, &len, fp)) != -1) {
            line[strcspn(line, "\r\n")] = 0;
            LOGD("%s", line);
        }
        if (line) {
            free(line);
        }
        fclose(fp);
    }

    return retval;
#endif
}

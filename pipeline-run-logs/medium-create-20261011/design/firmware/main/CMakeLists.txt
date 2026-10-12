# PINOUT is copied beside firmware by the build evidence tool.
set(PINOUT_FILE "${PROJECT_DIR}/../docs/PINOUT.md" CACHE FILEPATH "Reviewed pinout source")
if(NOT EXISTS "${PINOUT_FILE}")
    message(FATAL_ERROR "docs/PINOUT.md is required to generate firmware pins")
endif()
set(GENERATED_DIR "${CMAKE_BINARY_DIR}/generated")
execute_process(COMMAND "${PYTHON}" "${PROJECT_DIR}/tools/generate_pins.py"
    --pinout "${PINOUT_FILE}" --output "${GENERATED_DIR}/pins.h"
    --snapshot "${PROJECT_DIR}/pins.h"
    RESULT_VARIABLE PIN_RESULT)
if(NOT PIN_RESULT EQUAL 0)
    message(FATAL_ERROR "PINOUT generation or snapshot validation failed")
endif()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${PINOUT_FILE}" "${PROJECT_DIR}/tools/generate_pins.py" "${PROJECT_DIR}/pins.h")
idf_component_register(SRCS "app_main.c" "board_hal.c" "drivers.c"
    INCLUDE_DIRS "." "${GENERATED_DIR}"
    REQUIRES driver esp_driver_gpio esp_timer)

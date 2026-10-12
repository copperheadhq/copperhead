#include "board_hal.h"
#include "drivers.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "environment";

void app_main(void)
{
    const uint8_t crc_example[] = {0xBE, 0xEF};
    if (sht40_crc(crc_example, 2) != 0x92) {
        ESP_LOGE(TAG, "CRC self-check failed");
        return;
    }
    esp_err_t err = board_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "HAL initialization: %s", esp_err_to_name(err));
        return;
    }
    bool valid = false, display_ready = false;
    bool old_fault = false;
    float temperature = 0, humidity = 0;
    unsigned cycle = 0;
    TickType_t deadline = xTaskGetTickCount();
    /* One task owns the bus. Absolute 500ms deadlines separate 1Hz/2Hz cadences. */
    while (true) {
        if ((cycle % 2) == 0) {
            err = sht40_measure(&temperature, &humidity);
            valid = err == ESP_OK;
            if (valid)
                ESP_LOGI(TAG, "t_us=%lld T=%.2f C RH=%.2f %%",
                    (long long)esp_timer_get_time(), temperature, humidity);
            else
                ESP_LOGE(TAG, "Sensor invalid: %s; retry next 1Hz sample", esp_err_to_name(err));
        }
        bool fault = board_power_fault();
        if (fault != old_fault) {
            ESP_LOGW(TAG, "EF_FAULT_N %s", fault ? "asserted" : "released");
            old_fault = fault;
        }
        if (!display_ready) {
            err = oled_init();
            display_ready = err == ESP_OK;
            if (!display_ready) ESP_LOGE(TAG, "OLED init: %s", esp_err_to_name(err));
        }
        if (display_ready) {
            err = oled_render(valid, temperature, humidity, fault);
            if (err != ESP_OK) {
                display_ready = false;
                ESP_LOGE(TAG, "OLED write: %s; retry next refresh", esp_err_to_name(err));
            }
        }
        ++cycle;
        vTaskDelayUntil(&deadline, pdMS_TO_TICKS(500));
    }
}

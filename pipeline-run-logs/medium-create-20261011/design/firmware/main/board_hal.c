#include "board_hal.h"
#include "pins.h"
#include "driver/gpio.h"
#include "driver/i2c.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define BUS I2C_NUM_0
#define TIMEOUT pdMS_TO_TICKS(100)

esp_err_t board_init(void)
{
    gpio_config_t reset = {.pin_bit_mask = 1ULL << PIN_OLED_RST, .mode = GPIO_MODE_OUTPUT};
    esp_err_t err = gpio_config(&reset);
    if (err != ESP_OK) return err;
    gpio_set_level(PIN_OLED_RST, 0);
    /* External R4 defines FAULT_N; internal pulls are intentionally disabled. */
    gpio_config_t fault = {.pin_bit_mask = 1ULL << PIN_EF_FAULT_N, .mode = GPIO_MODE_INPUT};
    err = gpio_config(&fault);
    if (err != ESP_OK) return err;
    /* R10/R11 supply the reviewed pullups; firmware adds no strap loading. */
    i2c_config_t config = {.mode = I2C_MODE_MASTER, .sda_io_num = PIN_I2C_SDA,
        .scl_io_num = PIN_I2C_SCL, .sda_pullup_en = GPIO_PULLUP_DISABLE,
        .scl_pullup_en = GPIO_PULLUP_DISABLE, .master.clk_speed = 100000};
    err = i2c_param_config(BUS, &config);
    if (err != ESP_OK) return err;
    return i2c_driver_install(BUS, config.mode, 0, 0, 0);
}

esp_err_t board_write(uint8_t address, const uint8_t *data, size_t size)
{
    return i2c_master_write_to_device(BUS, address, data, size, TIMEOUT);
}

esp_err_t board_read(uint8_t address, uint8_t *data, size_t size)
{
    return i2c_master_read_from_device(BUS, address, data, size, TIMEOUT);
}

void board_oled_reset(void)
{
    gpio_set_level(PIN_OLED_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(PIN_OLED_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
}

bool board_power_fault(void)
{
    return gpio_get_level(PIN_EF_FAULT_N) == 0;
}

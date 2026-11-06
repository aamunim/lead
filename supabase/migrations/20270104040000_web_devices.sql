-- =====================================================================
-- 🌐 The website is not a phone
--   Website visits were saved without a device name (shown as "📱 Phone")
--   and with the key 'phone'. Phones always send their EAS channel and a
--   name (brand + model); the website sends neither (before 2.8.1).
--   * old website lines → "🌐 Website"
--   * the website's push check-ins (no token, ever) are removed
-- =====================================================================

update public.app_devices
   set device_label = '🌐 Website'
 where channel is null and update_id is null
   and (device_label is null or device_label in ('Android', 'phone', 'Phone'));

update public.app_sessions
   set device_label = '🌐 Website'
 where device_id is null
   and (device_label is null or device_label in ('Android', 'phone', 'Phone'));

delete from public.push_devices where platform = 'web';

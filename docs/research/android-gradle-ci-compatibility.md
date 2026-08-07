# Android Gradle CI compatibility findings

Investigation date: 2026-08-07

## Finding

`androidx.health.connect:connect-client:1.1.0` is the stable Health Connect 1.1 release. The dependency’s CI diagnostic requires `compileSdk >= 36` and AGP `>= 8.9.1`. This matches AndroidX’s own build logic, which maps `compileSdk 36` to `minAgpVersion 8.9.1` ([AndroidX source](https://android.googlesource.com/platform/frameworks/support/+/22e01b714d42172570eab7407cfb695809ce5af8/buildSrc/private/src/main/kotlin/androidx/build/AndroidXImplPlugin.kt)). Android’s API-level support table independently lists AGP 8.9.1 as the minimum AGP for API 36 ([Android Developers: About AGP](https://developer.android.com/build/releases/about-agp#api-level-support)).

AGP 8.9.1 must run with Gradle 8.11.1: Android’s AGP compatibility table gives 8.11.1 as the minimum for the 8.9 line, and the AGP 8.9 release notes list 8.11.1 as the minimum/default Gradle version and JDK 17 ([AGP compatibility table](https://developer.android.com/build/releases/about-agp#updating-gradle), [AGP 8.9 release notes](https://developer.android.com/build/releases/agp-8-9-0-release-notes)). Gradle documents that the Wrapper’s `distributionUrl` selects the Gradle distribution used by the build and recommends the Wrapper for controlled CI builds ([Gradle Wrapper](https://docs.gradle.org/current/userguide/gradle_wrapper.html)).

## Recommended version set

| Setting               | Recommendation                                                  |
| --------------------- | --------------------------------------------------------------- |
| Health Connect        | `androidx.health.connect:connect-client:1.1.0`                  |
| `compileSdk`          | `36`                                                            |
| Android Gradle Plugin | `8.9.1` or later; use `8.9.1` as the minimum compatible version |
| Gradle Wrapper        | `8.11.1` (`gradle-8.11.1-bin.zip`)                              |
| JDK                   | `17`                                                            |

The current working tree already has this set: `android/build.gradle.kts` uses AGP 8.9.1, `android/app/build.gradle.kts` uses `compileSdk = 36`, and `android/gradle/wrapper/gradle-wrapper.properties` uses Gradle 8.11.1. No further Android version change is required by this compatibility check. `targetSdk = 35` is separate from the compileSdk/AGP compatibility requirement and was not changed.

The first post-upgrade CI compile also required the Health Connect 1.1.0 Kotlin API spelling: use `HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS` rather than calling `getHealthConnectSettingsAction()` directly. The [HealthConnectClient API reference](https://developer.android.com/reference/androidx/health/connect/client/HealthConnectClient) documents the action as a static property, and the [AndroidX source](https://android.googlesource.com/platform/frameworks/support/+/d40efbfcc8684651783df15bccc0fb2e42d0d3c0/health/connect/connect-client/src/main/java/androidx/health/connect/client/HealthConnectClient.kt) shows its `@JvmStatic`/`@JvmName` declaration.

# Privacy And Permissions

## Data Collection Disclosure

```text
The extension collects buyer/contact email and Amazon job-search email for paid access validation. It reads supported Amazon hiring pages to match job listings and continue the booking/application flow. It communicates with getslotnow.com for license checks, checkout creation, and access validation. Payment is handled by Dodo hosted checkout. The extension does not sell user data and does not call Supabase directly.
```

## Permission Justification

```text
This extension needs access to Amazon hiring pages to detect available warehouse job listings, match the user's selected search criteria, and continue the booking/application flow only after the user has valid paid access. Storage is used to save local extension preferences and the cached access state. Tabs/activeTab/scripting are used to coordinate the popup with the active Amazon hiring tab.
```

## Host Permission Justification

```text
Amazon hiring host permissions are required because the extension operates only on Amazon job-search and application pages for Canada. getslotnow.com is required for paid access validation and checkout creation.
```

## Paid Feature Disclosure

```text
The extension requires paid access. Checkout is hosted by Dodo. The extension supports 30-day access and annual/pro access. Access is tied to the Amazon job-search email entered during checkout.
```

# KMail API — endpoint coverage

All **82** endpoints from the KMail OpenAPI document (`GET /v3/api-docs`), each mapped to
the spec file(s) that exercise it. Generated from the source, not by hand. **Covered: 82/82.**

## Translation (3)

| Endpoint | Spec file(s) |
|---|---|
| `POST /v2/translator/unusedpostMail` | translator |
| `POST /v2/translator/translation` | translator |
| `POST /v2/translator/postMail` | auth, compose, drafts, translator |

## Sent Mail (8)

| Endpoint | Spec file(s) |
|---|---|
| `POST /v2/sentMail/postMail` | attachments, auth, compose, drafts, translator |
| `POST /v2/sentMail/postMailMultiPart/` | attachments, compose, translator |
| `POST /v2/sentMail/postBulkMail` | compose |
| `POST /v2/sentMail/postBulkMailMultipart` | compose |
| `POST /v2/sentMail/loadMail` | compose |
| `POST /v2/sentMail/getMailCredentials` | compose |
| `GET /v2/sentMail/loadOtherDomainMails` | attachments, compose |
| `GET /v2/sentMail/bulkMail/status/{fromAddress}` | auth, compose |

## Read Mail & Attachments (10)

| Endpoint | Spec file(s) |
|---|---|
| `POST /v2/readMail/sentAndInboxMailContent` | read |
| `POST /v2/readMail/referenceMailContent` | read |
| `POST /v2/readMail/getKmailDetailsUsingKmailID` | read |
| `POST /v2/readMail/draftMailContent` | drafts |
| `POST /v2/readMail/downloadODAttachment` | attachments |
| `POST /v2/readMail/downloadAttachment` | attachments |
| `GET /v2/readMail/mediaStreaming/{uuid}` | attachments, auth |
| `GET /v2/readMail/getCopiesInfo/{kmailID}` | auth, read |
| `GET /v2/readMail/downloadThumbnail/{uuid}` | attachments, auth |
| `GET /v2/readMail/download/{uuid}` | attachments, auth |

## KMail Settings (19)

| Endpoint | Spec file(s) |
|---|---|
| `POST /v2/kmailSetting/setLetterHead` | settings |
| `POST /v2/kmailSetting/saveOrUpdateMailSignature` | settings |
| `POST /v2/kmailSetting/saveOrUpdateMailSignatureTemplateId` | settings |
| `POST /v2/kmailSetting/saveOrUpdateMailSignatureStyle` | settings |
| `POST /v2/kmailSetting/saveOrUpdateMailSignatureSocialMediaLink` | settings |
| `POST /v2/kmailSetting/saveOrUpdateMailSignaturePersonalData` | settings |
| `POST /v2/kmailSetting/saveOrUpdateMailSignatureGraphics` | settings |
| `POST /v2/kmailSetting/saveOrUpdateMailSignatureCompanyData` | settings |
| `POST /v2/kmailSetting/saveOrUpdateCustomizedSaluations` | settings |
| `POST /v2/kmailSetting/saveOrUpdateCustomizedInstantReply` | settings |
| `POST /v2/kmailSetting/letterHeadUpload` | settings |
| `POST /v2/kmailSetting/deleteLetterHead` | settings |
| `POST /v2/kmailSetting/deleteCustomizedSaluation` | settings |
| `POST /v2/kmailSetting/deleteCustomizedInstantReply` | settings |
| `GET /v2/kmailSetting/getMailSignature` | settings |
| `GET /v2/kmailSetting/getLetterHead` | settings |
| `GET /v2/kmailSetting/getLetterHeadTemplate` | settings |
| `GET /v2/kmailSetting/getDigitalSignature` | settings |
| `GET /v2/kmailSetting/getAllLetterHead` | settings |

## Draft Mail (6)

| Endpoint | Spec file(s) |
|---|---|
| `POST /v2/draft/getDraftMailsForSelectedContact` | drafts |
| `POST /v2/draft/draftMail` | drafts |
| `POST /v2/draft/draftMailMultiPart/` | drafts |
| `POST /v2/draft/deleteDraftMail` | drafts |
| `GET /v2/draft/getDraftMailsContacts` | drafts |
| `GET /v2/draft/getAllDraftMails` | compose, drafts, read |

## Mailbox & Contacts (33)

| Endpoint | Spec file(s) |
|---|---|
| `POST /v2/common/unusedstatusOfKmailsContacts` | folders |
| `POST /v2/common/unusedpostBoxContacts` | contacts |
| `POST /v2/common/statusOfKmailsContactsWithCount` | folders |
| `POST /v2/common/setKmailAsImportant` | actions, auth |
| `POST /v2/common/sentMailNotOpened` | folders, read |
| `POST /v2/common/selectedContactMails` | search |
| `POST /v2/common/saveUnsubscriberDetails` | auth, contacts |
| `POST /v2/common/replyNotSent` | folders |
| `POST /v2/common/replyNotRequiredBySender` | actions |
| `POST /v2/common/replyNotRequiredByReceiver` | actions |
| `POST /v2/common/replyNotReceived` | actions, folders |
| `POST /v2/common/mailSubjectSelectedContact` | search |
| `POST /v2/common/knownPostBoxContacts` | contacts |
| `POST /v2/common/kmailGroupReadStatus` | actions |
| `POST /v2/common/getKmailDashboardNewMsg` | folders |
| `POST /v2/common/getKmailDashboardMsg` | auth, folders |
| `POST /v2/common/getBulkKmailDashboardMsg` | folders |
| `POST /v2/common/getAllMailCount` | folders |
| `POST /v2/common/getAllImportantMails` | folders |
| `POST /v2/common/editOtherDomainContactsDetails` | contacts |
| `POST /v2/common/deleteOtherDomainContact` | contacts |
| `POST /v2/common/deleteKmailWithDeletedBy` | actions, auth |
| `POST /v2/common/convertMailAsPDF` | actions |
| `POST /v2/common/clearStatusOfKmailsContacts` | actions |
| `POST /v2/common/clearStatusOfAllKmailsContacts` | actions |
| `POST /v2/common/addOtherDomainContacts` | contacts |
| `GET /v2/common/unOpenedMailCountBySenderID` | folders |
| `GET /v2/common/statusOfKmailsContactsTotalCount` | folders |
| `GET /v2/common/miscellaneousContacts` | contacts |
| `GET /v2/common/mailServerConnection` | contacts |
| `GET /v2/common/getSaluations` | contacts, settings |
| `GET /v2/common/getInstantReply` | contacts, settings |
| `GET /v2/common/frequentKmailContact` | contacts |

## Sent Mail (Legacy Path) (1)

| Endpoint | Spec file(s) |
|---|---|
| `POST /sentMail/postMailMultiPart/` | attachments, compose, translator |

## kpost-application (1)

| Endpoint | Spec file(s) |
|---|---|
| `GET /` | auth |

## Storage Quota (1)

| Endpoint | Spec file(s) |
|---|---|
| `GET /v2/kmailData/getKloudUsedData` | attachments, auth |

